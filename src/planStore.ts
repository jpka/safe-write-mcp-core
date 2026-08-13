import { randomBytes } from "node:crypto";

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
}

export interface PlanStoreOptions {
  /** How long a plan token stays valid (ms). */
  planTtlMs: number;
  /** Audit sink the store emits lifecycle events to. Defaults to NoopSink. */
  audit?: AuditSink;
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
 */
export class PlanStore<TPayload> {
  private tokens = new Map<string, TokenEntry<TPayload>>();
  private audit: AuditSink;

  constructor(private opts: PlanStoreOptions) {
    this.audit = opts.audit ?? NoopSink;
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
    });
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
    this.emit(startedAt, "approved", planToken, entry.meta);
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
    this.emit(startedAt, "rejected", planToken, entry.meta);
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
    this.emit(startedAt, "executed", planToken, entry.meta);
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
      this.audit.record(event);
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
