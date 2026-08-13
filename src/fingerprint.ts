import { createHash } from "node:crypto";

/**
 * Stable JSON serialization for fingerprinting: object keys are sorted
 * recursively (and `undefined` values dropped), so two logically identical
 * payloads — no matter the key insertion order they were built in — always
 * produce the same string. This is what lets the core bind a plan token to a
 * host's preview artifact without trusting the caller to serialize it the
 * same way twice.
 *
 * Contract (mirrors JSON.stringify semantics):
 * - Values with a `toJSON()` method are canonicalized as what `toJSON(key)`
 *   returns, with the enclosing JSON key passed in — key-sensitive `toJSON`
 *   implementations produce the same fingerprint as `JSON.stringify`.
 * - When an object member's `toJSON(key)` returns `undefined`, the member is
 *   omitted (as JSON.stringify does), not encoded as `null`.
 * - Array holes and `undefined` elements encode as `null`, so `[undefined]`
 *   and `[]` never collide.
 * - A top-level `undefined` payload encodes as `null` rather than crashing.
 * - Cyclic payloads throw a deliberate TypeError instead of overflowing the
 *   stack with a RangeError.
 * - Anything that cannot be canonicalized deterministically — `Map`, `Set`,
 *   `RegExp`, `bigint`, `symbol`, functions, and other non-plain objects
 *   without `toJSON` — is rejected with a deliberate error instead of
 *   silently collapsing to `{}` (which would let changed values pass the
 *   fingerprint check).
 *
 * @param ancestors objects currently being traversed; used to reject cycles.
 */
function canonicalJson(
  value: unknown,
  key: string,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "undefined") return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    // JSON.stringify handles NaN/Infinity -> "null" and -0 -> "0" the same
    // way every JSON encoder does; keep JSON semantics.
    return JSON.stringify(value);
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new TypeError(`cannot fingerprint a ${typeof value} value at ${path}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`cannot fingerprint a cyclic value at ${path}`);
  }
  ancestors.add(value);
  try {
    const objectValue = value as Record<string, unknown> & { toJSON?: (k: string) => unknown };
    if (typeof objectValue.toJSON === "function") {
      return canonicalJson(objectValue.toJSON(key), key, path, ancestors);
    }

    if (Array.isArray(value)) {
      return `[${Array.from(value, (v, i) => canonicalJson(v, String(i), `${path}[${i}]`, ancestors)).join(",")}]`;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(
        `cannot fingerprint a non-plain object at ${path} (only plain objects, arrays, and values with toJSON are supported)`,
      );
    }

    // Resolve toJSON per member with its key (JSON semantics); omit members
    // whose toJSON returns undefined, same as JSON.stringify.
    const resolvedEntries: Array<[string, unknown]> = [];
    for (const [memberKey, memberValue] of Object.entries(objectValue)) {
      if (memberValue === undefined) continue;
      const memberToJson =
        memberValue !== null && typeof memberValue === "object"
          ? (memberValue as { toJSON?: (k: string) => unknown }).toJSON
          : undefined;
      if (typeof memberToJson === "function") {
        const resolved = memberToJson(memberKey);
        if (resolved === undefined) continue;
        resolvedEntries.push([memberKey, resolved]);
      } else {
        resolvedEntries.push([memberKey, memberValue]);
      }
    }
    resolvedEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${resolvedEntries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, k, `${path}.${k}`, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * sha256 over the canonical serialization of a payload. The plan token is
 * bound to this hash, so `consume()` can refuse a changed payload without
 * trusting the caller's claim that it is the same one. Throws a TypeError for
 * payloads that cannot be canonicalized deterministically or contain cycles
 * (see canonicalJson).
 */
export function fingerprint(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload, "", "$", new Set())).digest("hex");
}
