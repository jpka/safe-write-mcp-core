# DECISIONS

Each entry records a single architectural decision: the question, what the options were, what we picked, and the reasoning a reviewer can check. Newest first.

---

## 2026-08-13 — Why plan state is in-memory (restart loses pending plans)

**Question:** Should `PlanStore` persist plan tokens (a SQL table, a JSONL file) so pending plans survive a server restart?

**Decision:** No persistence — plans live in a `Map` in process memory; a restart loses every pending plan, and consumers must treat tokens as process-scoped. Confirmed deliberately in C7.

**Why:** Every persistence option trades a real, near-term guarantee for a theoretical one. The core is a *library*, not a server: it cannot assume a filesystem, a database, or a process that lives long enough to matter. The guarantees that actually need to survive restarts are (a) rejected plans stay rejected — handled by the tombstone design but *not* persisted, so a restart does silently resurrect a rejected plan; (b) executed plans never re-execute — a restarted host re-issues fresh tokens anyway, so no replay risk. The alternative — pluggable persistence behind an interface — is real work with real failure modes (partial writes, crash consistency, token invalidation on snapshot) for a consumer base of zero. The failure mode of in-memory state is *conservative*: a restart invalidates all pending plans, so nothing executes without re-previewing, which is exactly the safe direction. When a real consumer needs durable approval state, that's a host-side concern — the host already owns audit persistence, and the audit log plus a restart-all-revokes convention is a coherent first cut.

**Result:** `PlanStoreOptions` is just `{ planTtlMs, audit? }`. No persistence hooks, no serialization contract, no storage adapter.

---

## 2026-08-13 — Loopback-only approval surface, hardened against CSRF and DNS rebinding

**Question:** The human approval UI is an HTTP server. Where can it bind, and what stops an unrelated webpage on the same machine from silently approving or rejecting plans?

**Decision:** Bind to `127.0.0.1` only — never configurable, never `0.0.0.0` — and gate every route on request provenance: `Host` must name a loopback hostname carrying the actual bound port, and `Origin`/`Sec-Fetch-Site`, when present, must match. This is the same approach the approval server took in sw-postgres-mcp (#7/#19), with one refinement from CodeRabbit review: the `Host` allowlist is the four loopback names (`127.0.0.1`, `localhost`, `[::1]`, `::1`) rather than a single pinned string, so `http://localhost:<port>` — what a human actually types — works while the port pin keeps DNS-rebinding protection intact.

**Why:** Loopback binding alone does not stop CSRF — any page open in a browser on the same machine can reach `http://127.0.0.1:<port>/...`. The distinguisher between "the human clicked Approve" and "an unrelated webpage fired a background POST" is the browser-set provenance headers. Pinning the port to `req.socket.localPort` (not the configured port, which may be 0) closes the DNS-rebinding hole where a hostile name resolves to 127.0.0.1. Rejected alternatives: token-in-URL secrets (leak via referrer/logs and break the page on reload), a random port the human must find (the page is the whole point — it must be reachable), and "localhost in a config" (the boundary must not depend on a host remembering to turn security on). Trade-off accepted: the surface is unusable from any other machine by construction — that is the requirement, not a bug.

**Result:** `checkRequestProvenance` runs on every route including read-only ones; the approve/reject POSTs additionally require `application/json` — rejecting HTML form submissions with `415 UNSUPPORTED_MEDIA_TYPE` (browser form POSTs are never preflighted) while subjecting cross-origin JSON fetch/XHR requests to the browser's preflight, which the provenance checks then reject — and cap the body at 64 KiB.

---

## 2026-08-13 — Reject-as-tombstone: a rejected plan stays PLAN_REJECTED for the process lifetime

**Question:** What should happen to a rejected plan's token? Does `consume()` after rejection report the rejection, or does the token quietly vanish once it would have expired?

**Decision:** `reject()` marks the entry `rejected` and leaves it in the store as a permanent tombstone — exempt from the expiry sweep, and checked *first* in `consume()` and `approve()`, so a rejected plan reports `PLAN_REJECTED` ahead of `PLAN_EXPIRED`, `PLAN_USED`, and everything else, for the process lifetime. Rejecting twice is an idempotent no-op that keeps the first reason. The tombstone is not persisted (see the in-memory state entry) — a restart loses it and the token reports `UNKNOWN_TOKEN` again.

**Why:** A rejected plan is the one plan whose status a reviewer must never be able to misread. If rejection decayed into `UNKNOWN_TOKEN` or `PLAN_EXPIRED` after the TTL, a confused or adversarial agent could treat "human said no" as "token fell off the shelf, re-preview" and route around the rejection by re-running the same write with a fresh token — the exact thing rejection exists to prevent. The tombstone also gives a deterministic answer to "what error wins?": rejected wins over everything, which hosts and test suites can rely on. Cost: rejected plans hold memory until the process exits, with no count or byte limit (`PlanStoreOptions` exposes none and `sweep()` skips rejected entries), so a host that must bound memory long-term would need to add its own compaction or cap on top of this decision. That price is worth a guarantee a safety mechanism can be audited against.

**Result:** `TokenEntry.rejected` + `rejectionReason`, checked before all other gates; `sweep()` skips rejected entries.

---

## 2026-08-13 — Generalizing sw-postgres-mcp's statementFingerprint to a payload fingerprint

**Question:** sw-postgres-mcp bound a plan token to a sha256 over the SQL statement text (`statementFingerprint`). The shared core must bind tokens to *any* preview artifact. How should the fingerprint generalize?

**Decision:** `fingerprint(payload)` — sha256 over a canonical JSON serialization of the payload, recursive, key-sorted, with JSON.stringify semantics: `toJSON()` is honored (with the enclosing JSON key, so key-sensitive `toJSON` implementations match `JSON.stringify`), object members whose `toJSON` returns `undefined` are omitted, array holes and `undefined` elements encode as `null`, a top-level `undefined` encodes as `null`, and anything that cannot be canonicalized deterministically (Map/Set/RegExp/bigint/other non-plain objects without `toJSON`) — or is cyclic — is rejected with a deliberate `TypeError`.

**Why:** The original bound the token to the statement string, which worked only because a SQL statement is already a string. A Shopify price manifest, an inventory adjustment object, or any other structured payload is not — and the naive generalization (JSON.stringify + hash) has four landmines that review caught: `Map`/`Set`/`RegExp` collapse to `{}` (changed values pass the fingerprint check), `[undefined]` and `[]` collide, a top-level `undefined` crashes `create()` with a crypto error, and key order changes the hash. (`Date` is not a landmine — it serializes to an ISO string via its built-in `toJSON()`, which the canonicalizer honors.) The canonicalizer makes "logically identical payload" (same JSON, however constructed) hash identically, while making *different* payloads hash differently — which is the entire contract `consume()`'s `PLAN_MISMATCH` check depends on. Rejecting non-plain objects rather than best-effort-serializing them is deliberate: a payload the core cannot canonicalize deterministically must be refused at `create()` time, fail-closed, not hashed into a false sense of binding.

**Result:** `src/fingerprint.ts` with 12 regression tests; `PlanStore.consume()` compares `entry.fingerprint !== fingerprint(payload)` and reports `PLAN_MISMATCH` with the hint to pass back the exact preview payload.
