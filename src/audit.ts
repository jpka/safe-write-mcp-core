/**
 * The audit vocabulary shared by every safe-write server built on this core.
 * The core only emits the transitions it owns; hosts emit the rest through
 * the same sink (which they also hold a reference to).
 */
export type AuditStatus =
  | "previewed"
  | "awaiting_approval"
  | "approved"
  | "executed"
  | "rejected"
  | "refused"
  | "failed"
  | "rolled_back";

export interface AuditEvent {
  /** Epoch milliseconds when the event was emitted. */
  ts: number;
  /** The MCP tool that drove the transition (e.g. "update_prices"). */
  tool: string;
  reason: string | null;
  /** The plan token, or null when no token exists (e.g. a host-side "refused"). */
  planToken: string | null;
  status: AuditStatus;
  previewCount: number | null;
  callerId: string;
  /** Wall-clock time of the transition that produced this event, in ms. */
  durationMs: number;
  /** Extra context — e.g. the error code + message for a "failed" event. */
  detail?: string | null;
}

/**
 * A host's audit persistence contract: `record()` must never throw and must
 * return synchronously. The declared `undefined` return type rejects async
 * implementations at compile time — a rejected promise would bypass the
 * core's try/catch and become an unhandled rejection. Hosts needing async
 * persistence (a database write) should enqueue inside `record()` and flush
 * out-of-band. The core wraps every call in a try/catch and attaches a
 * rejection handler to any thenable it detects, as defense-in-depth — but a
 * sink that throws or rejects is a sink bug, not something the core works
 * around silently.
 */
export interface AuditSink {
  record(event: AuditEvent): undefined;
}

/** Default sink: drops everything. Used when no host audit persistence is configured. */
export const NoopSink: AuditSink = {
  record() {
    return undefined;
  },
};
