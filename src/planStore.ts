import { randomBytes } from "node:crypto";

import { NoopJournal, makeJournalEntry } from "./journal.js";
import type { Journal, JournalEntry } from "./journal.js";
import { replayJournal } from "./replay.js";
import { NoopSink } from "./audit.js";
import type { AuditEvent, AuditSink, AuditStatus } from "./audit.js";
import { fingerprint } from "./fingerprint.js";
import { PlanError } from "./errors.js";

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
   * Optional digest over the previewed data (e.g. a row-set digest), returned
   * on a successful `consume()` so the host can re-verify the data still
   * matches before executing (sw-postgres-mcp's ROWSET_CHANGED check).
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

export type ConsumeResult<TPayload = unknown> =
  | { ok: true; meta: PlanMeta }
  | { ok: false; error: PlanError; meta: PlanMeta | null };

export type ApproveResult =
  | { ok: true; alreadyApproved: boolean; meta: PlanMeta }
  | { ok: false; error: PlanError; meta: PlanMeta | null };

export type RejectResult =
  | { ok: true; alreadyRejected: boolean; meta: PlanMeta }
  | { ok: false; error: PlanError; meta: PlanMeta | null };

/**
 * Result of beginExecute(): the host must call confirmExecuted() or
 * confirmFailed() to close the lifecycle. If the process crashes between
 * beginExecute() and the confirm, the plan is stuck in "executing" — a
 * queryable state the host can detect on restart.
 */
export type BeginExecuteResult =
  | { ok: true; planToken: string; meta: PlanMeta }
  | { ok: false; error: PlanError; meta: PlanMeta | null };

export type ConfirmResult =
  | { ok: true; meta: PlanMeta }
  | { ok: false; error: PlanError; meta: PlanMeta | null };

/**
 * Host-supplied reconciliation callback. Called after confirmExecuted() to
 * verify the external side effect actually happened. Returns:
 * - 'done': the side effect is confirmed; the plan is marked executed.
 * - 'not-done': the side effect did not happen; the plan is marked failed.
 * - 'unknown': the side effect status is indeterminate; the plan stays in
 *   "executing" (the host can retry reconciliation later).
 */
export type ReconcileResult = "done" | "not-done" | "unknown";

export type ReconcileCallback = (planToken: string, meta: PlanMeta) => ReconcileResult | Promise<ReconcileResult>;

interface TokenEntry<TPayload> {
  payload: TPayload;
  fingerprint: string;
  meta: PlanMeta;
  expiresAt: number;
  used: boolean;
  requiresApproval: boolean;
  approved: boolean;
  /**
   * True once reject() has been called. A permanent tombstone: the entry is
   * exempt from the expiry sweep and consume()/approve() report
   * PLAN_REJECTED for it ahead of every other check.
   */
  rejected: boolean;
  /** Human-supplied rejection reason, surfaced back to the agent's next consume() attempt. */
  rejectionReason: string | null;
  /**
   * True once beginExecute() has been called but neither confirmExecuted()
   * nor confirmFailed() has closed the lifecycle. A plan stuck in this state
   * after a crash is queryable via listExecuting() — the host can reconcile
   * it rather than silently forgetting it.
   */
  executing: boolean;
}

export interface PlanStoreOptions {
  /** How long a plan token stays valid (ms). */
  planTtlMs: number;
  /** Audit sink the store emits lifecycle events to. Defaults to NoopSink. */
  audit?: AuditSink;
  /**
   * Durable journal. When configured, every plan transition is appended to
   * the journal before the in-memory state is mutated. On construction the
   * journal is replayed to restore state. Defaults to NoopJournal.
   */
  journal?: Journal;
  /**
   * Host-supplied reconciliation callback. Required when using the
   * beginExecute()/confirmExecuted() lifecycle. Called after the host
   * confirms execution to verify the external side effect.
   */
  reconcile?: ReconcileCallback;
}

/**
 * The two-phase plan lifecycle every safe-write server shares, ported from
 * sw-postgres-mcp's TokenStore and generalized over the preview payload type:
 * a plan is created from a previewed payload, bound to a fingerprint of that
 * payload, single-use, expiring, and — when gated — only executable after a
 * human approves it out-of-band.
 *
 * v0.2 adds crash safety: consume() is split into beginExecute() →
 * confirmExecuted() / confirmFailed(), with a durable journal recording
 * every transition. A plan stuck in "executing" after a crash is queryable
 * via listExecuting() and can be reconciled via the host-supplied callback.
 *
 * The host decides *whether* to create a plan (thresholds, hard caps,
 * preview execution are all host-side); this store decides the lifecycle
 * once a plan exists.
 */
export class PlanStore<TPayload> {
  private tokens = new Map<string, TokenEntry<TPayload>>();
  private audit: AuditSink;
  private journal: Journal;
  private reconcile: ReconcileCallback | undefined;

  constructor(private opts: PlanStoreOptions) {
    this.audit = opts.audit ?? NoopSink;
    this.journal = opts.journal ?? NoopJournal;
    this.reconcile = opts.reconcile;
    this.restoreFromJournal();
  }

  /**
   * Replay the journal to restore in-memory state. Called once on
   * construction. Plans stuck in "executing" are restored so the host can
   * detect and reconcile them.
   */
  private restoreFromJournal(): void {
    const entries = this.journal.replay();
    const now = Date.now();
    for (const entry of entries) {
      // Skip expired entries (unless rejected — tombstones survive)
      if (now > entry.expiresAt && !entry.flags.rejected) continue;
      // Skip used entries
      if (entry.flags.used) continue;

      // Reconstruct the meta
      const meta: PlanMeta = {
        tool: entry.meta.tool,
        reason: entry.meta.reason,
        callerId: entry.meta.callerId,
        previewCount: entry.meta.previewCount,
        dataDigest: entry.meta.dataDigest,
        extra: { ...entry.meta.extra },
      };

      // We cannot reconstruct the payload from the journal — only the
      // fingerprint. For plans that are still "executing" after a crash,
      // the host must re-create the payload (it was the host's in-flight
      // work). We store a sentinel payload and rely on the fingerprint
      // check in beginExecute() to catch any mismatch.
      // For non-executing plans, the payload is not needed until consume
      // time, at which point the host must provide the original payload.
      // We use an empty object as a placeholder — the fingerprint check
      // will fail if the host passes a different payload.
      const payload = {} as TPayload;

      this.tokens.set(entry.token, {
        payload,
        fingerprint: entry.fingerprint,
        meta,
        expiresAt: entry.expiresAt,
        used: entry.flags.used,
        requiresApproval: entry.flags.requiresApproval,
        approved: entry.flags.approved,
        rejected: entry.flags.rejected,
        rejectionReason: entry.flags.rejectionReason,
        executing: entry.flags.executing,
      });
    }
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
    this.tokens.set(token, {
      payload,
      fingerprint: fingerprint(payload),
      meta,
      expiresAt,
      used: false,
      requiresApproval,
      approved: !requiresApproval,
      rejected: false,
      rejectionReason: null,
      executing: false,
    });
    this.journal.append(
      makeJournalEntry(token, requiresApproval ? "awaiting_approval" : "previewed", expiresAt, fingerprint(payload), meta, {
        requiresApproval,
        approved: !requiresApproval,
        rejected: false,
        rejectionReason: null,
        used: false,
        executing: false,
      }),
    );
    this.emit(startedAt, requiresApproval ? "awaiting_approval" : "previewed", token, meta);
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
   * Plans stuck in "executing" — beginExecute() was called but neither
   * confirmExecuted() nor confirmFailed() closed the lifecycle. After a
   * crash, these are the plans that need reconciliation. Returns the tokens
   * and their metadata so the host can query the external system.
   */
  listExecuting(): Array<{ planToken: string; meta: PlanMeta }> {
    const out: Array<{ planToken: string; meta: PlanMeta }> = [];
    for (const [token, entry] of this.tokens) {
      if (entry.executing) {
        out.push({ planToken: token, meta: entry.meta });
      }
    }
    return out;
  }

  /**
   * Marks a plan approved so a subsequent consume() no longer refuses it
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
      this.journal.append(
        makeJournalEntry(planToken, "approved", entry.expiresAt, entry.fingerprint, entry.meta, {
          requiresApproval: entry.requiresApproval,
          approved: true,
          rejected: entry.rejected,
          rejectionReason: entry.rejectionReason,
          used: entry.used,
          executing: entry.executing,
        }),
      );
      this.emit(startedAt, "approved", planToken, entry.meta);
    }
    return { ok: true, alreadyApproved, meta: entry.meta };
  }

  /**
   * Permanently kills a plan: it can never be approved or executed afterward,
   * no matter what is later done to it. Unlike approve()/consume() this does
   * not delete the entry — it stays as a tombstone (see TokenEntry.rejected)
   * so a later consume()/approve() reports the distinguishable PLAN_REJECTED
   * error instead of falling through to UNKNOWN_TOKEN once enough time has
   * passed. Idempotent: rejecting an already-rejected plan succeeds again
   * without changing anything. The first rejection reason wins.
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
      this.journal.append(
        makeJournalEntry(planToken, "rejected", entry.expiresAt, entry.fingerprint, entry.meta, {
          requiresApproval: entry.requiresApproval,
          approved: entry.approved,
          rejected: true,
          rejectionReason: entry.rejectionReason,
          used: entry.used,
          executing: entry.executing,
        }),
      );
      this.emit(startedAt, "rejected", planToken, entry.meta);
    }
    return { ok: true, alreadyRejected, meta: entry.meta };
  }

  /**
   * The single gate every execute path must pass. Check ordering is
   * deliberate and must not be reordered:
   * rejected (permanent kill, wins over everything) → used → expired →
   * fingerprint mismatch → awaiting approval. A failure never marks the
   * token used, and a token that still awaits approval stays pending so a
   * later approve() + consume() can succeed.
   */
  consume(planToken: string, payload: TPayload): ConsumeResult<TPayload> {
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
    if (entry.requiresApproval && !entry.approved) {
      // Deliberately does not delete or mark the token used: it stays pending
      // so a later approve() + consume() can still succeed.
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
    entry.used = true;
    this.journal.append(
      makeJournalEntry(planToken, "executed", entry.expiresAt, entry.fingerprint, entry.meta, {
        requiresApproval: entry.requiresApproval,
        approved: entry.approved,
        rejected: entry.rejected,
        rejectionReason: entry.rejectionReason,
        used: true,
        executing: false,
      }),
    );
    this.emit(startedAt, "executed", planToken, entry.meta);
    return { ok: true, meta: entry.meta };
  }

  /**
   * v0.2: begin the execute lifecycle. Transitions the plan to "executing"
   * state and returns the plan token + metadata. The host then makes the
   * external API call. After the call, the host MUST call either
   * confirmExecuted() or confirmFailed() to close the lifecycle.
   *
   * If the process crashes between beginExecute() and the confirm, the plan
   * is stuck in "executing" — queryable via listExecuting() and reconcilable
   * via the host-supplied reconcile callback.
   *
   * Check ordering mirrors consume(): rejected → used → expired →
   * fingerprint mismatch → awaiting approval → already executing.
   */
  beginExecute(planToken: string, payload: TPayload): BeginExecuteResult {
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
    if (entry.requiresApproval && !entry.approved) {
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
    if (entry.executing) {
      return this.failed(
        startedAt,
        planToken,
        entry.meta,
        new PlanError(
          "PLAN_EXECUTING",
          "This plan is already being executed. A crash may have left it in 'executing' state. Reconcile before retrying.",
          "Check the external system to see if the side effect happened, then call confirmExecuted() or confirmFailed() to close the lifecycle.",
        ),
      );
    }
    entry.executing = true;
    this.journal.append(
      makeJournalEntry(planToken, "executing", entry.expiresAt, entry.fingerprint, entry.meta, {
        requiresApproval: entry.requiresApproval,
        approved: entry.approved,
        rejected: entry.rejected,
        rejectionReason: entry.rejectionReason,
        used: false,
        executing: true,
      }),
    );
    this.emit(startedAt, "executing", planToken, entry.meta);
    return { ok: true, planToken, meta: entry.meta };
  }

  /**
   * v0.2: confirm that the external side effect happened. Transitions the
   * plan to "executed" and marks it used. If a reconcile callback is
   * configured, it is called first — the callback verifies the side effect
   * against the external system.
   *
   * If reconcile returns 'unknown', the plan stays in "executing" (the host
   * can retry later). If reconcile returns 'not-done', the plan is marked
   * failed (not executed). If reconcile returns 'done' (or no callback is
   * configured), the plan is marked executed.
   */
  async confirmExecuted(planToken: string, meta?: PlanMeta): Promise<ConfirmResult> {
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
          "PLAN_NOT_EXECUTING",
          "This plan is not in 'executing' state. It may have already been confirmed.",
        ),
      );
    }

    // If a reconcile callback is configured, call it to verify the side effect
    if (this.reconcile) {
      const reconcileResult = await this.reconcile(planToken, entry.meta);
      if (reconcileResult === "not-done") {
        entry.executing = false;
        entry.used = false;
        this.journal.append(
          makeJournalEntry(planToken, "failed", entry.expiresAt, entry.fingerprint, entry.meta, {
            requiresApproval: entry.requiresApproval,
            approved: entry.approved,
            rejected: entry.rejected,
            rejectionReason: entry.rejectionReason,
            used: false,
            executing: false,
          }),
        );
        this.emit(startedAt, "failed", planToken, entry.meta, "RECONCILE_NOT_DONE: external side effect not confirmed");
        return {
          ok: false,
          error: new PlanError(
            "RECONCILE_NOT_DONE",
            "Reconciliation confirmed the external side effect did not happen.",
            "The plan was not executed. Re-preview and retry.",
          ),
          meta: entry.meta,
        };
      }
      if (reconcileResult === "unknown") {
        // Plan stays in "executing" — the host can retry later.
        return {
          ok: false,
          error: new PlanError(
            "RECONCILE_UNKNOWN",
            "Reconciliation could not determine if the external side effect happened.",
            "The plan remains in 'executing' state. Retry reconciliation later.",
          ),
          meta: entry.meta,
        };
      }
      // reconcileResult === "done" — fall through to mark executed
    }

    entry.executing = false;
    entry.used = true;
    this.journal.append(
      makeJournalEntry(planToken, "executed", entry.expiresAt, entry.fingerprint, entry.meta, {
        requiresApproval: entry.requiresApproval,
        approved: entry.approved,
        rejected: entry.rejected,
        rejectionReason: entry.rejectionReason,
        used: true,
        executing: false,
      }),
    );
    this.emit(startedAt, "executed", planToken, entry.meta);
    return { ok: true, meta: entry.meta };
  }

  /**
   * v0.2: confirm that the external side effect did NOT happen. Transitions
   * the plan to "failed" and clears the executing flag. The plan is NOT
   * marked used — the host can retry with a new beginExecute().
   */
  confirmFailed(planToken: string, reason?: string): ConfirmResult {
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
          "PLAN_NOT_EXECUTING",
          "This plan is not in 'executing' state. It may have already been confirmed.",
        ),
      );
    }
    entry.executing = false;
    entry.used = false;
    this.journal.append(
      makeJournalEntry(planToken, "failed", entry.expiresAt, entry.fingerprint, entry.meta, {
        requiresApproval: entry.requiresApproval,
        approved: entry.approved,
        rejected: entry.rejected,
        rejectionReason: entry.rejectionReason,
        used: false,
        executing: false,
      }),
    );
    this.emit(startedAt, "failed", planToken, entry.meta, reason ?? "host confirmed execution failed");
    return { ok: true, meta: entry.meta };
  }

  /**
   * Removes entries that are past their expiry or were already consumed.
   * Rejected entries are deliberately exempt — they are kept as tombstones so
   * a late consume()/approve() still reports PLAN_REJECTED. Called
   * automatically on every create(); exposed for hosts that want to bound
   * memory on their own schedule.
   */
  sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.rejected) continue;
      if (entry.used || now > entry.expiresAt) {
        this.tokens.delete(token);
      }
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
