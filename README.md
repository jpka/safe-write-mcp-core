# safe-write-mcp-core

Two-phase write core for MCP servers: preview-then-execute plan tokens, out-of-band localhost approval, and audit hooks. Zero runtime dependencies, transport-agnostic — hosts supply `preview()`/`execute()` callbacks and an audit persistence implementation.

**Status:** core complete (plan store, approval server, audit). Version 0.1.0, not yet published.

**Consumers:** [sw-postgres-mcp](https://github.com/jpka/sw-postgres-mcp) · [shopify-operations-mcp](https://github.com/jpka/shopify-operations-mcp)

---

## Why this package exists

An agent running a write-capable MCP server is one keystroke away from "UPDATE products SET price = 0". The safe-write pattern forces every mutating operation through a two-phase lifecycle that a human can intercept:

1. **Preview** — the host runs the read-only half of the operation (or estimates its impact) and asks the core for a plan.
2. **Decide** — a gated plan sits in a pending queue until a human approves or rejects it on a localhost approval page. No agent-visible path can approve it.
3. **Execute** — the agent redeems the plan token with the *exact* previewed payload. Any change to the payload, the token, or the plan's state is refused.

The core owns the plan lifecycle only. Everything policy-shaped — thresholds, hard caps, what a preview looks like, how data is persisted — is the host's job, which is what keeps this package generic enough to be shared.

## What the core guarantees

- **Fingerprint-bound plan tokens.** A plan token is bound to a sha256 fingerprint of the previewed payload (canonical JSON: sorted keys, JSON.stringify semantics). `consume()` recomputes the fingerprint and refuses `PLAN_MISMATCH` if the payload changed — the caller can't claim "same thing, trust me".
- **Single-use, expiring tokens.** A token executes at most once; a second `consume()` is `PLAN_USED` and the entry is pruned. Tokens expire after `planTtlMs`; `consume()`/`approve()`/`reject()` on an expired token are `PLAN_EXPIRED` (and the entry is pruned).
- **Out-of-band human approval.** Gated plans start `awaiting_approval` and cannot be consumed until approved. Approval only happens through the localhost approval server (or a host equivalent); `PlanStore.approve()` is not exposed to agents. `alwaysRequireApproval` forces the gate on operations that must always be human-approved (e.g. `run_migration`), and is a flag only tool-module code may set — never agent-supplied arguments.
- **Reject is permanent.** `reject()` writes a tombstone that outlives expiry and the sweep: a rejected plan reports `PLAN_REJECTED` ahead of every other check, forever. Rejection reasons are surfaced back to the agent's next `consume()` attempt. Rejecting twice is an idempotent no-op.
- **Deterministic gate ordering.** `consume()` checks, in order: rejected → used → expired → fingerprint mismatch → awaiting approval. Hosts and reviewers can rely on which error wins.
- **Audit events on every transition.** `previewed`/`awaiting_approval`/`approved`/`rejected`/`executed`/`failed` are emitted to an injectable `AuditSink` (default `NoopSink`). The sink contract is synchronous and never-throwing; a misbehaving sink is reported to stderr, never allowed to change a plan result.

## The preview/execute seam

The core is generic over the payload type `TPayload` and never talks to the host's data layer. The host:

1. Runs its own preview (or estimates impact) — the core doesn't know or care how.
2. Calls `store.create(payload, { tool, reason, ... })` → gets a `planToken`.
3. For gated plans, starts the approval server (same process, same store).
4. Calls `store.consume(planToken, payload)` from its execute path — the core re-verifies the fingerprint and returns the plan's metadata (including the host's optional `dataDigest`) so the host can re-check its own invariants before touching data.

The approval server renders plan cards through a host `renderPlan` hook (the core can't render a Shopify price manifest or a SQL statement generically) and reports every decision through an `onDecision` hook the host wires to its audit log.

## Usage

```ts
import { PlanStore, startApprovalServer } from "safe-write-mcp-core";

type Payload = { items: Array<{ id: number; price: number }> };

const store = new PlanStore<Payload>({ planTtlMs: 60_000 });

// Tool handler: preview half
const { planToken, status } = store.create(payload, {
  tool: "update_prices",
  reason: "markdown for the sale window",
  previewCount: payload.items.length,
  approvalRequired: payload.items.length > 50,
});
if (status === "awaiting_approval") {
  // Tell the agent: wait for human approval on the localhost page.
}

// Host startup: human approval surface on the same process/store
const { port } = await startApprovalServer(store, {
  renderPlan: (plan) => ({
    title: `${plan.tool}: ${plan.payload.items.length} items`,
    details: [{ label: "Preview", value: JSON.stringify(plan.payload) }],
  }),
  onDecision: (decision) => myAudit.record(decision), // host's own persistence
});

// Tool handler: execute half
const result = store.consume(planToken, payload); // re-verifies the payload
if (!result.ok) throw new Error(result.error.message);
```

## API surface

Exported from `safe-write-mcp-core`:

| Export | Kind | Purpose |
|---|---|---|
| `PlanStore<TPayload>` | class | `create` / `approve` / `reject` / `consume` / `listPending` / `sweep` |
| `PlanError` | class | structured error: `code`, `message`, `hint` |
| `fingerprint(payload)` | function | canonical-JSON sha256, also exported for hosts |
| `startApprovalServer` / `createApprovalServer` | functions | localhost HTTP approval UI (loopback-only, CSRF-hardened) |
| `AuditSink` / `NoopSink` / `AuditEvent` / `AuditStatus` | type/const | lifecycle event contract |

### PlanError codes

`UNKNOWN_TOKEN` · `PLAN_EXPIRED` · `PLAN_USED` · `PLAN_MISMATCH` · `AWAITING_APPROVAL` · `PLAN_REJECTED`

Hosts extend the vocabulary with their own domain codes (sw-postgres-mcp's `ROWSET_CHANGED`, a Shopify server's `STATE_CHANGED`) — the core only owns the token lifecycle.

### Approval server behavior

- Binds to `127.0.0.1` only, never `0.0.0.0` (port `0` = OS-assigned, used by tests).
- `Host` header must name a loopback host (`127.0.0.1`, `localhost`, `[::1]`) **and** carry the actual bound port; `Origin` and `Sec-Fetch-Site`, when present, must match — this is the DNS-rebinding / CSRF defense.
- `POST /api/plans/<token>/approve|reject` requires `Content-Type: application/json`, caps bodies at 64 KiB (`413 PAYLOAD_TOO_LARGE`), and never leaks internal error text to clients.
- Responses are `Cache-Control: no-store`; errors are structured `{ ok, code, message, hint }`.

## Development

```sh
npm install
npm run lint   # tsc --noEmit
npm test       # vitest run (73 tests)
npm run build  # tsc -> dist/ with declarations
```

Decisions behind the design are recorded in [DECISIONS.md](./DECISIONS.md).

## License

MIT — see [LICENSE](./LICENSE).
