import { createHash } from "node:crypto";

/**
 * Stable JSON serialization for fingerprinting: object keys are sorted
 * recursively (and `undefined` values dropped), so two logically identical
 * payloads — no matter the key insertion order they were built in — always
 * produce the same string. This is what lets the core bind a plan token to a
 * host's preview artifact without trusting the caller to serialize it the
 * same way twice.
 *
 * Contract:
 * - Values with a `toJSON()` method (e.g. `Date`) are canonicalized as what
 *   `toJSON()` returns, matching JSON.stringify.
 * - Array holes and `undefined` elements encode as `null` (JSON.stringify
 *   semantics), so `[undefined]` and `[]` never collide.
 * - A top-level `undefined` payload encodes as `null` rather than crashing.
 * - Anything that cannot be canonicalized deterministically — `Map`, `Set`,
 *   `RegExp`, `bigint`, `symbol`, functions, and other non-plain objects
 *   without `toJSON` — is rejected with a deliberate error instead of
 *   silently collapsing to `{}` (which would let changed values pass the
 *   fingerprint check).
 */
function canonicalJson(value: unknown, path: string): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "undefined") return "null";
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    // JSON.stringify handles NaN/Infinity -> "null" and -0 -> "0" the same
    // way every JSON encoder does; keep JSON semantics.
    return JSON.stringify(value);
  }
  if (type === "bigint" || type === "symbol" || type === "function") {
    throw new TypeError(`cannot fingerprint a ${type} value at ${path}`);
  }

  const maybeToJson = value as { toJSON?: unknown };
  if (typeof maybeToJson.toJSON === "function") {
    return canonicalJson((value as { toJSON(): unknown }).toJSON(), path);
  }

  if (Array.isArray(value)) {
    return `[${Array.from(value, (v, i) => canonicalJson(v, `${path}[${i}]`)).join(",")}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `cannot fingerprint a non-plain object at ${path} (only plain objects, arrays, and values with toJSON are supported)`,
    );
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, `${path}.${k}`)}`).join(",")}}`;
}

/**
 * sha256 over the canonical serialization of a payload. The plan token is
 * bound to this hash, so `consume()` can refuse a changed payload without
 * trusting the caller's claim that it is the same one. Throws a TypeError for
 * payloads that cannot be canonicalized deterministically (see canonicalJson).
 */
export function fingerprint(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload, "$")).digest("hex");
}
