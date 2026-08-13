import { createHash } from "node:crypto";

/**
 * Stable JSON serialization for fingerprinting: object keys are sorted
 * recursively (and `undefined` values dropped), so two logically identical
 * payloads — no matter the key insertion order they were built in — always
 * produce the same string. This is what lets the core bind a plan token to a
 * host's preview artifact without trusting the caller to serialize it the
 * same way twice.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * sha256 over the canonical serialization of a payload. The plan token is
 * bound to this hash, so `consume()` can refuse a changed payload without
 * trusting the caller's claim that it is the same one.
 */
export function fingerprint(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}
