import { randomBytes } from "node:crypto";

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

  constructor(private opts: PlanStoreOptions) {}

  create(payload: TPayload, options: PlanCreateOptions): PlanCreated {
    this.sweep();
    const token = randomBytes(24).toString("hex");
    const requiresApproval = options.alwaysRequireApproval === true || options.approvalRequired === true;
    const expiresAt = Date.now() + this.opts.planTtlMs;
    this.tokens.set(token, {
      payload,
      fingerprint: fingerprint(payload),
      meta: {
        tool: options.tool,
        reason: options.reason ?? null,
        callerId: options.callerId ?? "unknown",
        previewCount: options.previewCount ?? null,
        dataDigest: options.dataDigest ?? null,
        extra: options.extra ?? {},
      },
      expiresAt,
      used: false,
      requiresApproval,
      approved: !requiresApproval,
      rejected: false,
      rejectionReason: null,
    });
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
    const entry = this.tokens.get(planToken);
    if (!entry) {
      return {
        ok: false,
        error: new PlanError(
          "UNKNOWN_TOKEN",
          "No plan matches this token. It may have been revoked or never issued.",
        ),
        meta: null,
      };
    }
    if (entry.rejected) {
      return {
        ok: false,
        error: new PlanError(
          "PLAN_REJECTED",
          "This plan was rejected by a human reviewer and cannot be approved.",
          "A rejected plan cannot be un-rejected. Narrow the operation and re-preview to get a fresh token.",
        ),
        meta: entry.meta,
      };
    }
    if (entry.used) {
      return {
        ok: false,
        error: new PlanError(
          "PLAN_USED",
          "This plan token was already used and can no longer be approved.",
        ),
        meta: entry.meta,
      };
    }
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(planToken);
      return {
        ok: false,
        error: new PlanError(
          "PLAN_EXPIRED",
          "This plan token has expired. Re-run the write to obtain a fresh preview and token.",
        ),
        meta: entry.meta,
      };
    }
    const alreadyApproved = entry.approved;
    entry.approved = true;
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
    const entry = this.tokens.get(planToken);
    if (!entry) {
      return {
        ok: false,
        error: new PlanError(
          "UNKNOWN_TOKEN",
          "No plan matches this token. It may have been revoked or never issued.",
        ),
        meta: null,
      };
    }
    if (entry.used) {
      return {
        ok: false,
        error: new PlanError(
          "PLAN_USED",
          "This plan token was already executed and can no longer be rejected.",
        ),
        meta: entry.meta,
      };
    }
    // Skip the expiry check once already rejected: an already-dead token must
    // stay reported as PLAN_REJECTED forever, not flip to PLAN_EXPIRED (and
    // get pruned) just because wall-clock time passed between two reject()
    // calls.
    if (!entry.rejected && Date.now() > entry.expiresAt) {
      this.tokens.delete(planToken);
      return {
        ok: false,
        error: new PlanError(
          "PLAN_EXPIRED",
          "This plan token has already expired. There is nothing left to reject.",
        ),
        meta: entry.meta,
      };
    }
    const alreadyRejected = entry.rejected;
    entry.rejected = true;
    if (!entry.rejectionReason && reason) entry.rejectionReason = reason;
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
    const entry = this.tokens.get(planToken);
    if (!entry) {
      return {
        ok: false,
        error: new PlanError(
          "UNKNOWN_TOKEN",
          "No plan matches this token. It may have been revoked or never issued.",
        ),
        meta: null,
      };
    }
    if (entry.rejected) {
      return {
        ok: false,
        error: new PlanError(
          "PLAN_REJECTED",
          entry.rejectionReason
            ? `This plan was rejected by a human reviewer: ${entry.rejectionReason}`
            : "This plan was rejected by a human reviewer.",
          "This plan cannot be executed. Narrow the operation and re-preview to get a fresh token.",
        ),
        meta: entry.meta,
      };
    }
    if (entry.used) {
      this.tokens.delete(planToken);
      return {
        ok: false,
        error: new PlanError(
          "PLAN_USED",
          "This plan token was already used. A plan token can only be executed once.",
        ),
        meta: entry.meta,
      };
    }
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(planToken);
      return {
        ok: false,
        error: new PlanError(
          "PLAN_EXPIRED",
          "This plan token has expired. Re-run the write to obtain a fresh preview and token.",
        ),
        meta: entry.meta,
      };
    }
    if (entry.fingerprint !== fingerprint(payload)) {
      return {
        ok: false,
        error: new PlanError(
          "PLAN_MISMATCH",
          "The payload does not match the plan the token was issued for.",
          "Pass back the exact payload from the preview response.",
        ),
        meta: entry.meta,
      };
    }
    if (entry.requiresApproval && !entry.approved) {
      // Deliberately does not delete or mark the token used: it stays pending
      // so a later approve() + consume() can still succeed.
      return {
        ok: false,
        error: new PlanError(
          "AWAITING_APPROVAL",
          "This plan requires human approval and has not been approved yet.",
          "Approval happens out-of-band through a human approval process — it cannot be approved by the requesting agent. Wait for approval, or narrow the operation and re-preview.",
        ),
        meta: entry.meta,
      };
    }
    entry.used = true;
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
}
