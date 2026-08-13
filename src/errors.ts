/**
 * Error codes the plan lifecycle itself can produce. Hosts extend this with
 * their own domain codes (e.g. sw-postgres-mcp's ROWSET_CHANGED, a Shopify
 * server's STATE_CHANGED) — the core only owns the token lifecycle.
 */
export type PlanErrorCode =
  | "UNKNOWN_TOKEN"
  | "PLAN_EXPIRED"
  | "PLAN_USED"
  | "PLAN_MISMATCH"
  | "AWAITING_APPROVAL"
  | "PLAN_REJECTED";

/**
 * Structured error, mirroring the sw-postgres-mcp convention: `code` is
 * machine-actionable, `message` is human-readable, `hint` tells the caller
 * what to do next. Never expose a raw exception from a deeper layer.
 */
export class PlanError extends Error {
  readonly code: PlanErrorCode;
  readonly hint?: string;

  constructor(code: PlanErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
    this.hint = hint;
  }
}
