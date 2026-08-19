import { randomBytes } from "node:crypto";

import { NoopSink } from "./audit.js";
import type { AuditEvent, AuditSink, AuditStatus } from "./audit.js";
import { fingerprint } from "./fingerprint.js";
import { PlanError } from "./errors.js";
import { AppendOnlyJournal, replayJournal } from "./journal.js";
import type { JournalStatus, RecoveredExecuting } from "./journal.js";

/**
 * Host-supplied metadata recorded on the plan. `tool` names the MCP tool
 * driving the preview; the rest feeds audit rows and the human approval
 * surface (C3 renders these via a host `renderPlan` hook).
 */
export interface PlanMeta {
  tool: string;
  reason: string | null;
  callerId: string;
  /** A count a human approval surface can judge by (affected rows/items) — null when the host has nothing to count. */
  previewCount: number | null;
  /**
   * Digest over the previewed data (e.g. a row-set digest), set at `create()`
   * when the host wants the core to fail closed if the underlying data
   * changed before execution. When non-null, `beginExecute()` requires the
   * caller to pass the *current* digest and refuses `DATA_DIGEST_MISMATCH`
   * (never silently proceeds). When null, the check is a no-op.
   */
  dataDigest: string | null;
  /** Opaque host extras passed through to pending-plan cards (e.g. a target table). */
  extra: Readonly<Record<string, unknown>>;
}

export interface PlanCreateOptions {
  tool: string;
  reason?: string | null;
  callerId?: string;
  previewCount?: number | null;
  dataDigest?: string | null;
  extra?: Record<string, unknown>;
  /**
   * Forces `status: "awaiting_approval"` regardless of any host-side
   * threshold — the mechanism a host uses for operations that must always be
   * human-approved (sw-postgres-mcp's run_migration). Must only be set to
   * `true` by a tool module's own code, never from agent-supplied arguments.
   * Default false.
   */
  alwaysRequireApproval?: boolean;
  /** Approval threshold the host already evaluated; above it, the plan gates on human approval. Default false. */
  approvalRequired?: boolean;
}

export interface PlanCreated {
  /**
   * The plan token — and the **idempotency key** for execution. When the
   * downstream API a host calls from its execute path has no idempotency
   * support of its own, the host should key its own dedup ledger on this
   * token so that a retried `beginExecute()` (after a crash, a timeout, or a
   * `reconcile` outcome of "not-done") cannot double-apply an irreversible
   * side effect. See `beginExecute`.
   */
  planToken: string;
  status: "previewed" | "awaiting_approval";
  expiresAt: number;
}

/**
 * One pending plan, shaped for a human approval surface: everything it needs
 * to render a card — the exact preview payload, the agent's stated reason,
 * and the preview count — without exposing internal token state.
 */
export interface PendingPlan<TPayload> {
  planToken: string;
  tool: string;
  reason: string | null;
  callerId: string;
  previewCount: number | null;
  expiresAt: number;
  payload: TPayload;
  extra: Readonly<Record<string, unknown>>;
}

/**
 * One plan currently mid-execution — the handoff gap between `beginExecute`
 * and `confirmExecuted`/`confirmFailed`. A host that restarts and wants to
 * detect "stuck" executions compares `executingSince` against its own
 * timeout, or replays the journal and reconciles via `PlanStore.fromJournal`.
 */
export interface ExecutingPlan<TPayload> {
  planToken: string;
  tool: string;
  reason: string | null;
  callerId: string;
  previewCount: number | null;
  /** The digest the plan was bound to at create() — useful for a host deciding whether a retry is safe. */
  dataDigest: string | null;
  expiresAt: number;
  /** Epoch ms `beginExecute` started this execution — the reference point for a stuck-execution timeout. */
  executingSince: number;
  payload: TPayload;
  extra: Readonly<Record<string, unknown>>;
}

export type ConsumeResult<TPayload = unknown> =
  | { ok: true; meta: PlanMeta }
  | { ok: false; error: PlanError; meta: PlanMeta | null };

/** Shape of a `confirmExecuted` / `confirmFailed` / `reconcileStuck` result. */
export type ConfirmResult<TPayload = unknown> =
  | { ok: true; meta: PlanMeta }
  | { ok: false; error: PlanError; meta: PlanMeta | null };

export type ApproveResult =
  | { ok: true; alreadyApproved: boolean; meta: PlanMeta }
  | { ok: false; error: PlanError; meta: PlanMeta | null };

export type RejectResult =
  | { ok: true; alreadyRejected: boolean; meta: PlanMeta }
  | { ok: false; error: PlanError; meta: PlanMeta | null };

/**
 * What the host's `reconcile` hook answers when asked whether a plan's
 * external side effect actually happened:
 * - `"done"` — the side effect definitely happened → the token is marked executed.
 * - `"not-done"` — it definitely did not happen → the token is released back to retryable.
 * - `"unknown"` — the host cannot tell → the token stays `executing` and
 *   queryable as stuck; the core never guesses.
 */
export type ReconcileOutcome = "done" | "not-done" | "unknown";

/** Host-supplied answer to "did the external side effect actually happen?". Purely pluggable — the core hardcodes no vendor check. */
export type ReconcileCallback = (planToken: string) => Promise<ReconcileOutcome> | ReconcileOutcome;

interface TokenEntry<TPayload> {
  payload: TPayload;
  fingerprint: string;
  meta: PlanMeta;
  expiresAt: number;
  used: boolean;
  /** True between beginExecute and confirmExecuted/confirmFailed — the handoff gap. */
  executing: boolean;
  /** Epoch ms the execution began; null when not executing. */
  executingSince: number | null;
  requiresApproval: boolean;
  approved: boolean;
  /**
   * True once reject() has been called. A permanent tombstone: the entry is
   * exempt from the expiry sweep and beginExecute()/approve() report
   * PLAN_REJECTED for it ahead of every other check.
   */
  rejected: boolean;
  /** Human-supplied rejection reason, surfaced back to the agent's next beginExecute() attempt. */
  rejectionReason: string | null;
}

export interface PlanStoreOptions {
  /** How long a plan token stays valid (ms). */
  planTtlMs: number;
  /** Audit sink the store emits lifecycle events to. Defaults to NoopSink. */
  audit?: AuditSink;
  /**
   * Optional path for the append-only, fsync'd transition journal. When set,
   * every token state transition (created/approved/rejected/executing/
   * executed/failed) is appended as one JSON line before the in-memory change
   * becomes observable. A restarted host replays it via
   * `PlanStore.fromJournal` to recover tokens that were mid-execution. When
   * omitted, no journal is written and the library works with zero config.
   */
  journalPath?: string;
  /**
   * Host-supplied hook answering "did the external side effect actually
   * happen?" for a token left `executing` when the process died. Used by
   * `PlanStore.fromJournal` (and `reconcileStuck`) to settle recovered
   * tokens; the core never hardcodes a vendor-specific check. May be async.
   */
  reconcile?: ReconcileCallback;
  /**
   * How long `reconcileStuck` waits on the `reconcile` callback before
   * giving up. A callback that exceeds the deadline (or throws) is treated
   * as `"unknown"` — the token stays `executing` and queryable, never
   * guessed — so a hanging host hook cannot block `PlanStore.fromJournal`
   * recovery forever. Default 30000 ms.
   */
  reconcileTimeoutMs?: number;
}

/**
 * The two-phase plan lifecycle every safe-write server shares, ported from
 * sw-postgres-mcp's TokenStore and generalized over the preview payload type:
 * a plan is created from a previewed payload, bound to a fingerprint of that
 * payload, single-use, expiring, and — when gated — only executable after a
 * human approves it out-of-band.
 *
 * The host decides *whether* to create a plan (thresholds, hard caps,
 * preview execution are all host-side); this store decides the lifecycle
 * once a plan exists.
 *
 * Execution is a two-step handoff (see `beginExecute`/`confirmExecuted`/
 * `confirmFailed`) so the audit record is never causally disconnected from
 * the real-world side effect the host performs between the two calls.
 */
export class PlanStore<TPayload> {
  private tokens = new Map<string, TokenEntry<TPayload>>();
  private audit: AuditSink;
  private journal: AppendOnlyJournal | null;

  constructor(private opts: PlanStoreOptions) {
    this.audit = opts.audit ?? NoopSink;
    this.journal = opts.journalPath ? new AppendOnlyJournal(opts.journalPath) : null;
  }

  create(payload: TPayload, options: PlanCreateOptions): PlanCreated {
    const startedAt = Date.now();
    this.sweep();
    const token = randomBytes(24).toString("hex");
    const requiresApproval = options.alwaysRequireApproval === true || options.approvalRequired === true;
    const expiresAt = Date.now() + this.opts.planTtlMs;
    const meta: PlanMeta = {
      tool: options.tool,
      reason: options.reason ?? null,
      callerId: options.callerId ?? "unknown",
      previewCount: options.previewCount ?? null,
      dataDigest: options.dataDigest ?? null,
      extra: options.extra ?? {},
    };
    const entry: TokenEntry<TPayload> = {
      payload,
      fingerprint: fingerprint(payload),
      meta,
      expiresAt,
      used: false,
      executing: false,
      executingSince: null,
      requiresApproval,
      approved: !requiresApproval,
      rejected: false,
      rejectionReason: null,
    };
    this.tokens.set(token, entry);
    const status = requiresApproval ? "awaiting_approval" : "previewed";
    this.journalTransition(token, status, entry);
    this.emit(startedAt, status, token, meta);
    return {
      planToken: token,
      status: requiresApproval ? "awaiting_approval" : "previewed",
      expiresAt,
    };
  }

  /**
   * Plans still awaiting a human decision: requiresApproval, not yet
   * approved, not used, not rejected, and not expired. Expired entries are
   * deliberately omitted rather than flagged stale — an expired plan should
   * disappear from the pending list, not sit there approvable.
   */
  listPending(): PendingPlan<TPayload>[] {
    const now = Date.now();
    const out: PendingPlan<TPayload>[] = [];
    for (const [token, entry] of this.tokens) {
      if (!entry.requiresApproval) continue;
      if (entry.approved || entry.used || entry.rejected) continue;
      if (now > entry.expiresAt) continue;
      out.push({
        planToken: token,
        tool: entry.meta.tool,
        reason: entry.meta.reason,
        callerId: entry.meta.callerId,
        previewCount: entry.meta.previewCount,
        expiresAt: entry.expiresAt,
        payload: entry.payload,
        extra: entry.meta.extra,
      });
    }
    // Soonest-expiring first — the plans a human needs to act on most urgently lead the list.
    out.sort((a, b) => a.expiresAt - b.expiresAt);
    return out;
  }

  /**
   * Plans currently mid-execution (between `beginExecute` and
   * `confirmExecuted`/`confirmFailed`), oldest-started first. A host detects
   * *stuck* executions by comparing `executingSince` against its own timeout;
   * this list is deliberately kept complete (even past the plan TTL) so a
   * stuck token is queryable until the host settles it — nothing prunes an
   * executing entry.
   */
  listExecuting(): ExecutingPlan<TPayload>[] {
    const out: ExecutingPlan<TPayload>[] = [];
    for (const [token, entry] of this.tokens) {
      if (!entry.executing) continue;
      out.push({
        planToken: token,
        tool: entry.meta.tool,
        reason: entry.meta.reason,
        callerId: entry.meta.callerId,
        previewCount: entry.meta.previewCount,
        dataDigest: entry.meta.dataDigest,
        expiresAt: entry.expiresAt,
        executingSince: entry.executingSince ?? Date.now(),
        payload: entry.payload,
        extra: entry.meta.extra,
      });
    }
    out.sort((a, b) => a.executingSince - b.executingSince);
    return out;
  }

  /**
   * Marks a plan approved so a subsequent beginExecute() no longer refuses it
   * with AWAITING_APPROVAL. Does not consume the token — the host's execute
   * path still runs its own fingerprint/expiry checks afterward. Idempotent:
   * approving an already-approved (or never-gated) token succeeds without
   * error. Must only be reachable out-of-band (the localhost approval
   * server), never through an agent-facing MCP tool.
   */
  approve(planToken: string): ApproveResult {
    const startedAt = Date.now();
    const entry = this.tokens.get(planToken);
    if (!entry) {
      return this.failed(
        startedAt,
        planToken,
        null,
        new PlanError("UNKNOWN_TOKEN", "No plan matches this token. It may have been revoked or never issued."),
      );
    }
    if (entry.rejected) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "PLAN_REJECTED",
          "This plan was rejected by a human reviewer and cannot be approved.",
          "A rejected plan cannot be un-rejected. Narrow the operation and re-preview to get a fresh token.",
        ),
      );
    }
    if (entry.used) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError("PLAN_USED", "This plan token was already used and can no longer be approved."),
      );
    }
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(planToken);
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "PLAN_EXPIRED",
          "This plan token has expired. Re-run the write to obtain a fresh preview and token.",
        ),
      );
    }
    const alreadyApproved = entry.approved;
    entry.approved = true;
    if (!alreadyApproved) {
      this.journalTransition(planToken, "approved", entry);
      this.emit(startedAt, "approved", planToken, entry.meta);
    }
    return { ok: true, alreadyApproved, meta: entry.meta };
  }

  /**
   * Permanently kills a plan: it can never be approved or executed afterward,
   * no matter what is later done to it. Unlike approve()/beginExecute() this
   * does not delete the entry — it stays as a tombstone (see
   * TokenEntry.rejected) so a later beginExecute()/approve() reports the
   * distinguishable PLAN_REJECTED error instead of falling through to
   * UNKNOWN_TOKEN once enough time has passed. Idempotent: rejecting an
   * already-rejected plan succeeds again without changing anything. The first
   * rejection reason wins. A plan whose side effect is already in flight
   * cannot be rejected — it is too late to un-ring that bell.
   */
  reject(planToken: string, reason: string | null): RejectResult {
    const startedAt = Date.now();
    const entry = this.tokens.get(planToken);
    if (!entry) {
      return this.failed(
        startedAt,
        planToken,
        null,
        new PlanError("UNKNOWN_TOKEN", "No plan matches this token. It may have been revoked or never issued."),
      );
    }
    if (entry.used) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError("PLAN_USED", "This plan token was already executed and can no longer be rejected."),
      );
    }
    if (entry.executing) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "ALREADY_EXECUTING",
          "This plan's side effect is already in flight and can no longer be rejected.",
          "Confirm whether the execution succeeded before deciding the next step.",
        ),
      );
    }
    // Skip the expiry check once already rejected: an already-dead token must
    // stay reported as PLAN_REJECTED forever, not flip to PLAN_EXPIRED (and
    // get pruned) just because wall-clock time passed between two reject()
    // calls.
    if (!entry.rejected && Date.now() > entry.expiresAt) {
      this.tokens.delete(planToken);
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError("PLAN_EXPIRED", "This plan token has already expired. There is nothing left to reject."),
      );
    }
    const alreadyRejected = entry.rejected;
    entry.rejected = true;
    if (!entry.rejectionReason && reason) entry.rejectionReason = reason;
    if (!alreadyRejected) {
      this.journalTransition(planToken, "rejected", entry);
      this.emit(startedAt, "rejected", planToken, entry.meta);
    }
    return { ok: true, alreadyRejected, meta: entry.meta };
  }

  /**
   * The first step of the two-step execute handoff. Runs the same gate checks
   * `consume()` used to, in the same deliberate order (rejected → used →
   * already-executing → expired → fingerprint mismatch → data-digest mismatch
   * → awaiting approval), and on success puts the plan into `executing`
   * state — the plan is NOT yet marked used and NO `executed` audit event is
   * emitted. That happens in `confirmExecuted`, which the host calls only
   * after its external side effect has actually succeeded. A token in
   * `executing` is what the host performs its side effect against.
   *
   * **Idempotency key:** `planToken` is the idempotency key the host should
   * key its own dedup ledger on when the downstream API has no idempotency
   * support of its own — so that retrying after a crash (or after a
   * `reconcile` outcome of "not-done") can never double-apply an irreversible
   * action. The core cannot guarantee this for you; it only guarantees the
   * token is single-use within its own lifecycle.
   */
  beginExecute(planToken: string, payload: TPayload, currentDataDigest?: string | null): ConsumeResult<TPayload> {
    const startedAt = Date.now();
    const entry = this.tokens.get(planToken);
    if (!entry) {
      return this.failed(
        startedAt,
        planToken,
        null,
        new PlanError("UNKNOWN_TOKEN", "No plan matches this token. It may have been revoked or never issued."),
      );
    }
    if (entry.rejected) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "PLAN_REJECTED",
          entry.rejectionReason
            ? `This plan was rejected by a human reviewer: ${entry.rejectionReason}`
            : "This plan was rejected by a human reviewer.",
          "This plan cannot be executed. Narrow the operation and re-preview to get a fresh token.",
        ),
      );
    }
    if (entry.used) {
      this.tokens.delete(planToken);
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError("PLAN_USED", "This plan token was already used. A plan token can only be executed once."),
      );
    }
    if (entry.executing) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "ALREADY_EXECUTING",
          "This plan token is already executing and cannot be begun again.",
          "Confirm whether the previous execution succeeded (confirmExecuted/confirmFailed) before retrying.",
        ),
      );
    }
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(planToken);
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "PLAN_EXPIRED",
          "This plan token has expired. Re-run the write to obtain a fresh preview and token.",
        ),
      );
    }
    if (entry.fingerprint !== fingerprint(payload)) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "PLAN_MISMATCH",
          "The payload does not match the plan the token was issued for.",
          "Pass back the exact payload from the preview response.",
        ),
      );
    }
    if (entry.meta.dataDigest !== null) {
      // Fail closed, same posture as the fingerprint check: a changed data set
      // must never silently proceed. Undefined/null when the plan carries a
      // digest is treated as a mismatch (the caller must supply the current
      // digest whenever create() was given one).
      if (currentDataDigest !== entry.meta.dataDigest) {
        return this.failed(
          startedAt,
          planToken,
          entry.meta,
          new PlanError(
            "DATA_DIGEST_MISMATCH",
            "The current data digest does not match the digest the plan was previewed against.",
            "Re-preview against the current data to obtain a fresh token.",
          ),
        );
      }
    }
    if (entry.requiresApproval && !entry.approved) {
      // Deliberately does not delete or mark the token used: it stays pending
      // so a later approve() + beginExecute() can still succeed.
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "AWAITING_APPROVAL",
          "This plan requires human approval and has not been approved yet.",
          "Approval happens out-of-band through a human approval process — it cannot be approved by the requesting agent. Wait for approval, or narrow the operation and re-preview.",
        ),
      );
    }
    entry.executing = true;
    entry.executingSince = Date.now();
    this.journalTransition(planToken, "executing", entry);
    this.emit(startedAt, "executing", planToken, entry.meta);
    return { ok: true, meta: entry.meta };
  }

  /**
   * The second step of the two-step execute handoff — call after the host's
   * external side effect *succeeded*. Marks the plan used and emits the
   * `executed` audit event (only here, never in `beginExecute`), so the audit
   * record is causally connected to a side effect that really happened.
   * Errors with `NOT_EXECUTING` if the token isn't in `executing` state (e.g.
   * already confirmed, never begun, or settled by a recovery pass).
   */
  confirmExecuted(planToken: string): ConfirmResult<TPayload> {
    const startedAt = Date.now();
    const entry = this.tokens.get(planToken);
    if (!entry) {
      return this.failed(
        startedAt,
        planToken,
        null,
        new PlanError("UNKNOWN_TOKEN", "No plan matches this token. It may have been revoked or never issued."),
      );
    }
    if (!entry.executing) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "NOT_EXECUTING",
          "This plan token is not in an executing state, so it cannot be confirmed as executed.",
          "Only confirm after beginExecute succeeded and the side effect actually ran.",
        ),
      );
    }
    entry.executing = false;
    entry.executingSince = null;
    entry.used = true;
    this.journalTransition(planToken, "executed", entry);
    this.emit(startedAt, "executed", planToken, entry.meta);
    return { ok: true, meta: entry.meta };
  }

  /**
   * Call after the host's external side effect *definitively failed* — not
   * when the outcome is unknown (for that, leave the token executing and
   * reconcile it). Releases the plan back to a retryable state: it is NOT
   * marked used, so a later `beginExecute` can run it again (subject to the
   * usual gates — expiry, fingerprint, approval, and the host's own dedup
   * ledger keyed on `planToken`). Emits a `failed` audit event with detail
   * `EXECUTION_FAILED`. Errors with `NOT_EXECUTING` if the token isn't
   * executing.
   */
  confirmFailed(planToken: string): ConfirmResult<TPayload> {
    const startedAt = Date.now();
    const entry = this.tokens.get(planToken);
    if (!entry) {
      return this.failed(
        startedAt,
        planToken,
        null,
        new PlanError("UNKNOWN_TOKEN", "No plan matches this token. It may have been revoked or never issued."),
      );
    }
    if (!entry.executing) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "NOT_EXECUTING",
          "This plan token is not in an executing state, so it cannot be confirmed as failed.",
          "Only confirm after beginExecute succeeded.",
        ),
      );
    }
    entry.executing = false;
    entry.executingSince = null;
    this.journalTransition(planToken, "failed", entry, "EXECUTION_FAILED");
    this.emit(startedAt, "failed", planToken, entry.meta, "EXECUTION_FAILED");
    return { ok: true, meta: entry.meta };
  }

  /**
   * Settles a single stuck-executing token by asking the configured
   * `reconcile` callback whether the external side effect actually happened:
   * `"done"` → marked executed; `"not-done"` → released back to retryable;
   * `"unknown"` (or a throwing/erroring callback, treated the same) → left
   * executing and queryable, never guessed. Errors with `NOT_EXECUTING` if
   * the token isn't executing and `NO_RECONCILE` if no callback is
   * configured. Used by `fromJournal` for restart recovery and available to
   * hosts that want to re-check an "unknown" leftover later.
   */
  async reconcileStuck(planToken: string): Promise<ConfirmResult<TPayload>> {
    const startedAt = Date.now();
    const entry = this.tokens.get(planToken);
    if (!entry) {
      return this.failed(
        startedAt,
        planToken,
        null,
        new PlanError("UNKNOWN_TOKEN", "No plan matches this token. It may have been revoked or never issued."),
      );
    }
    if (!entry.executing) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "NOT_EXECUTING",
          "This plan token is not in an executing state, so there is nothing to reconcile.",
        ),
      );
    }
    if (!this.opts.reconcile) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "NO_RECONCILE",
          "No reconcile callback is configured, so this token cannot be settled.",
          "Pass a `reconcile` hook in PlanStoreOptions, or settle the token with confirmExecuted/confirmFailed.",
        ),
      );
    }
    let outcome: ReconcileOutcome;
    try {
      outcome = await this.reconcileWithTimeout(planToken);
    } catch (err) {
      // A broken reconcile hook must never guess on the host's behalf.
      process.stderr.write(`reconcile callback failed for ${planToken}: ${String(err)}\n`);
      outcome = "unknown";
    }
    if (outcome === "done") return this.confirmExecuted(planToken);
    if (outcome === "not-done") return this.confirmFailed(planToken);
    return { ok: true, meta: entry.meta };
  }

  /**
   * Runs the `reconcile` callback against a bounded deadline
   * (`reconcileTimeoutMs`, default 30000). A callback that overruns the
   * deadline rejects with a timeout error so the caller can treat it exactly
   * like a throwing callback — both are the documented `"unknown"` fail-safe,
   * never a guess. The timer is cleared in `finally` and `unref`'d so it can
   * neither leak nor keep the process alive after the race is settled.
   */
  private async reconcileWithTimeout(planToken: string): Promise<ReconcileOutcome> {
    const timeoutMs = this.opts.reconcileTimeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<ReconcileOutcome>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `reconcile callback timed out after ${timeoutMs}ms; treating the outcome as "unknown"`,
          ),
        );
      }, timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([this.opts.reconcile!(planToken), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Reconstructs a store from a transition journal after a restart: every
   * token whose last journaled state was `executing` is loaded back into
   * `executing` state (in-memory Map is the lookup source of truth; the
   * journal is what survives). When a `reconcile` hook is configured, each
   * recovered token is reconciled immediately (`done` → executed,
   * `not-done` → retryable, `unknown` → left executing and queryable); the
   * reconciled transitions are journaled back so a second restart does not
   * re-reconcile them. When no hook is configured, recovered tokens stay
   * executing and queryable via `listExecuting` until the host settles them.
   */
  static async fromJournal<TPayload>(
    journalPath: string,
    options: PlanStoreOptions,
  ): Promise<PlanStore<TPayload>> {
    // The recovered store continues the same journal it was replayed from —
    // reconciled transitions are appended to it so a second restart does not
    // re-reconcile tokens that were already settled.
    const store = new PlanStore<TPayload>({ ...options, journalPath });
    const executing = await replayJournal<TPayload>(journalPath);
    for (const rec of executing) {
      store.tokens.set(rec.planToken, {
        payload: rec.payload,
        fingerprint: rec.fingerprint,
        meta: rec.meta,
        expiresAt: rec.expiresAt,
        used: false,
        executing: true,
        executingSince: rec.beganAt,
        requiresApproval: rec.requiresApproval,
        approved: rec.approved,
        rejected: rec.rejected,
        rejectionReason: null,
      });
    }
    if (options.reconcile) {
      for (const rec of executing) {
        await store.reconcileStuck(rec.planToken);
      }
    }
    return store;
  }

  /**
   * Legacy one-step execute, kept for backward compatibility. It is a thin
   * wrapper around `beginExecute` + immediate `confirmExecuted`. Compared to
   * the old pre-v0.2 `consume()`, one behavior is deliberately different:
   * when `create()` was given a `dataDigest`, the plan now carries one and
   * `beginExecute` enforces it — so `consume()` fails closed with
   * `DATA_DIGEST_MISMATCH` unless the current digest is supplied. The audit
   * record still claims the side effect happened even though the host
   * performs it after this returns. New hosts must use the two-step handoff
   * instead; `consume()` exists so existing callers keep working and is not
   * recommended for crash-sensitive paths.
   */
  consume(planToken: string, payload: TPayload, currentDataDigest?: string | null): ConsumeResult<TPayload> {
    const begun = this.beginExecute(planToken, payload, currentDataDigest);
    if (!begun.ok) return begun;
    const confirmed = this.confirmExecuted(planToken);
    if (!confirmed.ok) {
      // Unreachable right after a successful beginExecute, but stay honest
      // rather than claim execution: release the token and report the failure.
      this.confirmFailed(planToken);
      return { ok: false, error: confirmed.error, meta: confirmed.meta };
    }
    return { ok: true, meta: begun.meta };
  }

  /**
   * Removes entries that are past their expiry or were already consumed.
   * Rejected entries are deliberately exempt — they are kept as tombstones so
   * a late beginExecute()/approve() still reports PLAN_REJECTED. Executing
   * entries are also exempt — a mid-flight side effect must stay queryable as
   * stuck until the host settles it. Called automatically on every create();
   * exposed for hosts that want to bound memory on their own schedule.
   */
  sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.rejected || entry.executing) continue;
      if (entry.used || now > entry.expiresAt) {
        this.tokens.delete(token);
      }
    }
  }

  /** Closes the journal file (if configured). Transitions after this are no longer journaled. */
  close(): void {
    this.journal?.close();
    this.journal = null;
  }

  /**
   * Appends the token's transition to the durable journal. The in-memory
   * mutation and this journal append happen back-to-back in the same
   * synchronous block with nothing observable in between — callers never see
   * a gap between the two. The record is durable (fsync'd) before this
   * method returns to the host. Future maintainers must never insert an
   * `await` or an early return between the in-memory mutation and the append,
   * or a crash could leave the journal behind the Map. Best-effort like the
   * audit sink: a journal failure is reported to stderr and never changes the
   * plan result.
   */
  private journalTransition(
    planToken: string,
    status: JournalStatus,
    entry: TokenEntry<TPayload>,
    detail?: string | null,
  ): void {
    if (!this.journal) return;
    try {
      this.journal.append({
        ts: Date.now(),
        planToken,
        status,
        detail: detail ?? null,
        tool: entry.meta.tool,
        reason: entry.meta.reason,
        callerId: entry.meta.callerId,
        previewCount: entry.meta.previewCount,
        dataDigest: entry.meta.dataDigest,
        extra: entry.meta.extra,
        expiresAt: entry.expiresAt,
        requiresApproval: entry.requiresApproval,
        approved: entry.approved,
        rejected: entry.rejected,
        fingerprint: entry.fingerprint,
        payload: entry.payload,
      });
    } catch (err) {
      // An unusable journal (broken after a write failure) reports loudly and
      // still never changes the plan result — see AppendOnlyJournal.append.
      process.stderr.write(`journal append failed: ${String(err)}\n`);
    }
  }

  /**
   * Emits a lifecycle event to the configured audit sink. The sink's contract
   * is "never throw", but this is wrapped anyway so a misbehaving sink can
   * never turn a failed audit write into a failed plan transition — a lost
   * audit row must not be confused with a lifecycle that didn't happen.
   */
  private emit(
    startedAt: number,
    status: AuditStatus,
    planToken: string,
    meta: PlanMeta | null,
    detail?: string | null,
  ): void {
    const event: AuditEvent = {
      ts: Date.now(),
      tool: meta?.tool ?? "unknown",
      reason: meta?.reason ?? null,
      planToken,
      status,
      previewCount: meta?.previewCount ?? null,
      callerId: meta?.callerId ?? "unknown",
      durationMs: Date.now() - startedAt,
      detail: detail ?? null,
    };
    try {
      const result = this.audit.record(event) as unknown;
      if (result && typeof (result as { then?: unknown }).then === "function") {
        // Defense-in-depth for JS hosts that ignore the `undefined` return
        // contract: a rejected promise would otherwise become an unhandled
        // rejection. Report it, never let it change the plan result.
        Promise.resolve(result).catch((err: unknown) => {
          process.stderr.write(`audit sink failed: ${String(err)}\n`);
        });
      }
    } catch (err) {
      process.stderr.write(`audit sink failed: ${String(err)}\n`);
    }
  }

  /**
   * Builds a failure result and audits it as "failed" in one step, so every
   * refusal path records its transition without duplicating the emit call.
   */
  private failed(
    startedAt: number,
    planToken: string,
    meta: PlanMeta | null,
    error: PlanError,
  ): { ok: false; error: PlanError; meta: PlanMeta | null } {
    this.emit(startedAt, "failed", planToken, meta, `${error.code}: ${error.message}`);
    return { ok: false, error, meta };
  }
}