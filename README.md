# Safe-write MCP core

Two-phase write core for MCP servers: preview-then-execute plan tokens, out-of-band localhost approval, and audit hooks. Zero runtime dependencies, transport-agnostic — hosts supply `preview()`/`execute()` callbacks and an audit persistence implementation.

**Status:** core complete (plan store, approval server, audit). Version 0.1.0, published.

---

## Why this package exists

An agent running a write-capable MCP server is one keystroke away from "UPDATE products SET price = 0". The safe-write pattern forces every mutating operation through a two-phase lifecycle that a human can intercept:

1. **Preview** — the host runs the read-only half of the operation (or estimates its impact) and asks the core for a plan.
2. **Decide** — a gated plan sits in a pending queue until a human approves or rejects it on a localhost approval page. The core never exposes approval to an agent: `PlanStore.approve()` is public API, so hosts must keep it out of agent-facing handlers and tools — the only sanctioned path is the human approval page.
3. **Execute** — the agent redeems the plan token with a payload whose canonical JSON fingerprint matches the previewed one (object key order may differ), then the host performs its side effect and confirms it. Any change to the payload's fingerprint, the token, or the plan's state is refused.

The core owns the plan lifecycle only. Everything policy-shaped — thresholds, hard caps, what a preview looks like, how data is persisted — is the host's job, which is what keeps this package generic enough to be shared.

## What the core guarantees

- **Fingerprint-bound plan tokens.** A plan token is bound to a sha256 fingerprint of the previewed payload (canonical JSON: sorted keys, JSON.stringify semantics). `beginExecute()` recomputes the fingerprint and refuses `PLAN_MISMATCH` if the payload changed — the caller can't claim "same thing, trust me".
- **Single-use, expiring tokens.** A token executes at most once. It moves through `executing` (between `beginExecute` and `confirmExecuted`) and a token already in flight refuses a second `beginExecute` with `ALREADY_EXECUTING`; a second `beginExecute` after `confirmExecuted` is `PLAN_USED` and the entry is pruned. Tokens expire after `planTtlMs`; `beginExecute()`/`approve()`/`reject()` on an expired token are `PLAN_EXPIRED` (and the entry is pruned). Executing entries are exempt from the expiry sweep so a stuck execution stays queryable.
- **Crash-safe execute handoff.** Execution is two steps so the audit record is never causally disconnected from the real world: `beginExecute(planToken, payload, currentDataDigest?)` runs the gates and transitions the plan to `executing` (no `executed` event yet); the host performs its external side effect against that token; then `confirmExecuted(planToken)` marks it used and emits `executed` — only here — or `confirmFailed(planToken)` releases it back to retryable. Optionally, `PlanStoreOptions.journalPath` writes every token transition to an append-only, fsync'd JSONL journal; on restart, `PlanStore.fromJournal(path, options)` replays it, reloads tokens that were mid-execute, and settles each one via the pluggable `reconcile` hook (`"done"` → executed, `"not-done"` → retryable, `"unknown"` → left queryable, never guessed). `listExecuting()` surfaces in-flight plans for stuck-execution detection.
- **Plan token as idempotency key.** `planToken` is the key hosts should use in their own dedup ledger when the downstream API has no idempotency support — so a retried execution after a crash or a `"not-done"` reconcile can never double-apply an irreversible action.
- **Out-of-band human approval.** Gated plans start `awaiting_approval` and cannot be executed until approved. Approval only happens through the localhost approval server (or a host equivalent) — the core ships no agent-facing approval surface, and hosts must keep `PlanStore.approve()` out of agent-facing handlers and tools. `alwaysRequireApproval` forces the gate on operations that must always be human-approved (e.g. `run_migration`), and is a flag only tool-module code may set — never agent-supplied arguments.
- **Reject is permanent for the process lifetime.** `reject()` writes a tombstone that outlives expiry and the sweep: a rejected plan reports `PLAN_REJECTED` ahead of every other check, until the process exits. Tombstones are in-memory only (see DECISIONS.md) — a restart loses them and a later `beginExecute()` returns `UNKNOWN_TOKEN`. Rejection reasons are surfaced back to the agent's next `beginExecute()` attempt. Rejecting twice is an idempotent no-op. A plan whose side effect is already in flight cannot be rejected (`ALREADY_EXECUTING`).
- **Deterministic gate ordering.** `beginExecute()` checks, in order: rejected → used → already-executing → expired → fingerprint mismatch → data-digest mismatch → awaiting approval. Hosts and reviewers can rely on which error wins.
- **Audit events on every transition the core owns.** `previewed`/`awaiting_approval`/`approved`/`executing`/`executed`/`rejected`/`failed` are emitted to an injectable `AuditSink` (default `NoopSink`) — including every refusal path. The sink contract is synchronous and never-throwing; a misbehaving sink is reported to stderr, never allowed to change a plan result. Host execution errors that happen *after* `beginExecute()` succeeds are outside the core's lifecycle and must be audited by the host through the shared `AuditSink`.

## The preview/execute seam

The core is generic over the payload type `TPayload` and never talks to the host's data layer. The host:

1. Runs its own preview (or estimates impact) — the core doesn't know or care how.
2. Calls `store.create(payload, { tool, reason, ... })` → gets a `planToken`.
3. For gated plans, starts the approval server (same process, same store).
4. Calls `store.beginExecute(planToken, payload, currentDataDigest?)` from its execute path — the core re-verifies the fingerprint (and, when `create()` was given a `dataDigest`, the current digest) and returns the plan's metadata, putting the token in `executing`. The host then performs its external side effect against that token and settles it: `confirmExecuted(planToken)` on success (marks used, emits `executed`), or `confirmFailed(planToken)` on a definitive failure (releases back to retryable).
5. On startup after a crash, `PlanStore.fromJournal(journalPath, options)` replays the transition journal, reloads tokens left `executing`, and settles each via the `reconcile` hook.

The approval server renders plan cards through a host `renderPlan` hook (the core can't render a Shopify price manifest or a SQL statement generically) and reports every decision through an `onDecision` hook the host wires to its audit log.

## Usage

```ts
import { PlanStore, startApprovalServer } from "safe-write-mcp-core";

type Payload = { items: Array<{ id: number; price: number }> };

const store = new PlanStore<Payload>({ planTtlMs: 60_000 });

// Tool handler: preview half — runs the read-only preview, then asks the core for a plan
function previewTool(payload: Payload): { planToken: string; approved: boolean } {
  const { planToken, status } = store.create(payload, {
    tool: "update_prices",
    reason: "markdown for the sale window",
    previewCount: payload.items.length,
    approvalRequired: payload.items.length > 50,
  });
  // When the plan gates on approval, the handler is done: tell the agent to
  // wait for a human on the localhost page. Do NOT proceed to beginExecute() yet.
  if (status === "awaiting_approval") return { planToken, approved: false };
  return { planToken, approved: true };
}

// Host startup: human approval surface on the same process/store
const { port } = await startApprovalServer(store, {
  renderPlan: (plan) => ({
    title: `${plan.tool}: ${plan.payload.items.length} items`,
    details: [{ label: "Preview", value: JSON.stringify(plan.payload) }],
  }),
  onDecision: (decision) => myAudit.record(decision), // host's own persistence
});

// Tool handler: execute half — runs only after approval (either the plan was
// not gated, or a human approved it on the localhost page). The planToken is
// your idempotency key: key your own dedup ledger on it if the downstream API
// has no idempotency support, so a retry can never double-apply the action.
function executeTool(planToken: string, payload: Payload): void {
  const begun = store.beginExecute(planToken, payload); // re-verifies the payload
  if (!begun.ok) throw new Error(begun.error.message);
  try {
    runSideEffect(payload); // the external, possibly irreversible call
    store.confirmExecuted(planToken); // now — and only now — "executed" is audited
  } catch (err) {
    // Confirm the outcome before choosing. `confirmFailed` is the
    // *definitive*-failure path: it releases the token back to retryable.
    // Only call it when the side effect is confirmed to have NOT applied.
    if (sideEffectDefinitivelyDidNotRun(err)) {
      store.confirmFailed(planToken);
    } else {
      // Indeterminate (timeout, dropped connection): the side effect may have
      // already run. Leave the token `executing` — it stays queryable via
      // `listExecuting()` and is settled later by `reconcileStuck()`. Releasing
      // it here could double-apply the action on a retry.
    }
    throw err;
  }
}

// After a crash, construct the store from the transition journal instead of
// from scratch: tokens that were mid-execute are reloaded and settled via
// `reconcile`, which answers "did the side effect actually happen?" per token.
const recoveredStore = await PlanStore.fromJournal("./journal.jsonl", {
  planTtlMs: 60_000,
  reconcile: async (token) => {
    if (myDedupLedger.has(token)) return "done"; // side effect definitely happened
    if (myNoOpLedger.has(token)) return "not-done"; // definitely did not happen
    return "unknown"; // cannot tell -> token stays `executing` and queryable, never guessed
  },
});
```

## API surface

Exported from `safe-write-mcp-core`:

| Export | Kind | Purpose |
|---|---|---|
| `PlanStore<TPayload>` | class | `create` / `approve` / `reject` / `beginExecute` / `confirmExecuted` / `confirmFailed` / `reconcileStuck` / `listPending` / `listExecuting` / `sweep` / `consume` (legacy) / `PlanStore.fromJournal` |
| `replayJournal(path)` | function | reconstructs tokens left `executing` in a journal (crash recovery) |
| `PlanError` | class | structured error: `code`, `message`, `hint` |
| `fingerprint(payload)` | function | canonical-JSON sha256, also exported for hosts |
| `startApprovalServer` / `createApprovalServer` | functions | localhost HTTP approval UI (loopback-only, CSRF-hardened) |
| `AuditSink` / `NoopSink` / `AuditEvent` / `AuditStatus` | type/const | lifecycle event contract |
| `ReconcileCallback` / `ReconcileOutcome` | type | host's answer to "did the side effect actually happen?" (`done` / `not-done` / `unknown`) |
| `JournalRecord` / `JournalStatus` | type | journal line schema and its state-transition vocabulary |
| `RecoveredExecuting` | type | a token a restart found mid-execution, reconstructed from the journal |

### PlanError codes

`UNKNOWN_TOKEN` · `PLAN_EXPIRED` · `PLAN_USED` · `PLAN_MISMATCH` · `DATA_DIGEST_MISMATCH` · `AWAITING_APPROVAL` · `PLAN_REJECTED` · `NOT_EXECUTING` · `ALREADY_EXECUTING` · `NO_RECONCILE`

Hosts extend the vocabulary with their own domain codes (sw-postgres-mcp's `ROWSET_CHANGED`, a Shopify server's `STATE_CHANGED`) — the core only owns the token lifecycle.

### Approval server behavior

- Binds to `127.0.0.1` only, never `0.0.0.0` (port `0` = OS-assigned, used by tests).
- `Host` header must name a loopback host (`127.0.0.1`, `localhost`, `[::1]`) **and** carry the actual bound port; `Origin` and `Sec-Fetch-Site`, when present, must match — this is the DNS-rebinding / CSRF defense.
- `POST /api/plans/<token>/approve|reject` requires `Content-Type: application/json`, caps bodies at 64 KiB (`413 PAYLOAD_TOO_LARGE`), and never leaks internal error text to clients.
- Responses are `Cache-Control: no-store`; errors are structured `{ ok, code, message, hint }` with `hint` optional (omitted by `FORBIDDEN`, `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`, `NOT_FOUND`, and `INTERNAL_ERROR`).

## Development

```sh
npm install
npm run lint   # tsc --noEmit
npm test       # vitest run (107 tests)
npm run build  # tsc -> dist/ with declarations
```

Decisions behind the design are recorded in [DECISIONS.md](./DECISIONS.md).

## License

MIT — see [LICENSE](./LICENSE).
