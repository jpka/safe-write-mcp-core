import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { PlanError } from "./errors.js";
import { PlanStore } from "./planStore.js";
import type { PendingPlan } from "./planStore.js";

/**
 * Loopback only, always — never configurable, never 0.0.0.0. This is the
 * whole security boundary the localhost approval UI depends on: it calls
 * `PlanStore.approve()`/`reject()` directly (not through the MCP tool
 * surface), so it must be unreachable from anywhere but the machine the
 * server runs on.
 */
const LOOPBACK_HOST = "127.0.0.1";

/** Host-header names that all resolve to this machine's loopback interface. */
const LOOPBACK_HOST_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const MAX_BODY_BYTES = 64 * 1024;

/** Rejects `readJsonBody` when a request body exceeds MAX_BODY_BYTES. */
class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * A plan's human-readable display fields, produced by the host's
 * `renderPlan` hook. The core has no idea what a payload *is* (a SQL
 * statement, a Shopify price manifest, ...), so the host tells it what to
 * show on a card.
 */
export interface RenderablePlan {
  /** Short label for the card heading. Defaults to the plan's tool name. */
  title?: string;
  /** Ordered key/value rows rendered under the card. */
  details: Array<{ label: string; value: string }>;
}

export type RenderPlan<TPayload> = (plan: PendingPlan<TPayload>) => RenderablePlan;

/** The outcome of an approve/reject attempt, delivered to the host's `onDecision` hook for auditing. */
export interface ApprovalDecision {
  action: "approve" | "reject";
  planToken: string;
  /** `approvedBy`/`rejectedBy` from the request body, or null. */
  actor: string | null;
  /** Rejection reason from the request body (approve always null). */
  reason: string | null;
  ok: boolean;
  /** True when the action was a no-op on an already-approved/already-rejected plan. */
  already: boolean;
  error: PlanError | null;
}

export interface ApprovalServerOptions<TPayload> {
  /** Port to bind. 0 = OS-assigned (used by tests). Default 0. */
  port?: number;
  /** Host hook shaping how a plan's payload is displayed. Defaults to a JSON dump of the payload. */
  renderPlan?: RenderPlan<TPayload>;
  /**
   * Host audit hook, invoked after every approve/reject attempt — success or
   * failure — with the action, actor, and outcome. This is where a host
   * records `approved`/`rejected` audit rows (see safe-write-mcp-core#5's
   * AuditSink, or sw-postgres-mcp's audit log). May be async.
   */
  onDecision?: (decision: ApprovalDecision) => void | Promise<void>;
  /** HTML page title. Default "Approval queue". */
  title?: string;
  /**
   * When true, `GET /api/plans` includes the raw `payload` field in each plan
   * object alongside the redacted `render` view. Default `false` — the raw
   * payload is omitted so a host's `renderPlan` redaction is not silently
   * bypassed by the JSON route. Set true only if you deliberately want the
   * unredacted payload on this surface and accept that it shares loopback
   * provenance with the approval page. See safe-write-mcp-core#18.
   */
  exposeRawPayload?: boolean;
  /**
   * Bearer token every route requires — including the read-only GET ones —
   * via `Authorization: Bearer <token>` or a `?token=` query-string
   * fallback (for a human pasting the URL, and for the built-in page's own
   * initial load). Defaults to a random 32-byte token generated per call
   * when omitted and `requireAuth` isn't `false`.
   *
   * Loopback binding plus the Host/Origin/Sec-Fetch-Site provenance checks
   * defend against a browser-driven CSRF page; neither stops a *different
   * local process* that simply sends the expected headers, since a plan
   * token alone was previously enough to approve or reject a plan. See
   * safe-write-mcp-core#20.
   *
   * `startApprovalServer` returns the resolved value on the handle so a
   * host running in-process can render links/fetch calls that already
   * carry it. A direct `createApprovalServer` caller that leaves both this
   * and `requireAuth` unset gets a server that requires a token nobody was
   * handed back — pass an explicit token if you need to know it.
   */
  authToken?: string;
  /**
   * Set to `false` to disable bearer-token authentication and fall back to
   * the pre-0.4.0 behaviour (loopback bind + provenance checks only, no
   * shared secret). Default `true`. Not recommended — see
   * safe-write-mcp-core#20 — but kept as an explicit opt-out so this isn't
   * a breaking change hosts can't work around.
   */
  requireAuth?: boolean;
}

export interface ApprovalServerHandle {
  server: http.Server;
  /** Actual bound port — resolved even when options.port is 0. */
  port: number;
  host: string;
  /**
   * The bearer token every route requires, or `null` when `requireAuth` was
   * set to `false`. Print this alongside the approval URL (e.g.
   * `http://127.0.0.1:<port>/?token=<token>`) so a human opening it in a
   * browser authenticates on first load.
   */
  token: string | null;
  close(): Promise<void>;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Pause, don't destroy: the handler must still be able to write a 413
        // response. The socket is destroyed once that response has flushed.
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        // A malformed body is not a reason to fail the whole action — treat
        // it the same as no body rather than a 400 for what is, worst case,
        // a UI bug.
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function statusForErrorCode(code: string): number {
  switch (code) {
    case "UNKNOWN_TOKEN":
      return 404;
    case "PLAN_EXPIRED":
      return 410; // Gone
    case "PLAN_USED":
    case "PLAN_REJECTED":
      return 409; // Conflict
    default:
      return 400;
  }
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Loopback binding alone does not stop CSRF: any page open in a browser on
 * the same machine can still reach `http://127.0.0.1:<port>/...`. What
 * distinguishes "the human loaded this approval page and clicked a button"
 * from "an unrelated webpage silently hit this endpoint in the background"
 * is request provenance: the Host the browser thinks it's talking to, the
 * Origin the request came from (when present), and the browser-set
 * Sec-Fetch-Site hint.
 *
 * `Host` must name a loopback host (`127.0.0.1`, `localhost`, or a bracketed
 * IPv6 loopback) AND carry the actual bound port — checked against
 * `req.socket.localPort` rather than the configured port, which can be 0
 * ("pick any free port"). Pinning the port keeps the DNS-rebinding defense
 * intact: an attacker-controlled hostname is never in the allowed set, and
 * the allowed names can't be pointed anywhere but this machine.
 *
 * `Origin` and `Sec-Fetch-Site` are only enforced when present: non-browser
 * clients (curl, the test suite) never send them, and that's a legitimate
 * way to reach this server — only a *mismatched* value is evidence of a
 * cross-origin request.
 */
function splitHostHeader(hostHeader: string): { name: string; port: string | null } {
  const lastColon = hostHeader.lastIndexOf(":");
  if (lastColon === -1 || hostHeader.endsWith("]")) return { name: hostHeader, port: null };
  return { name: hostHeader.slice(0, lastColon), port: hostHeader.slice(lastColon + 1) };
}

function checkRequestProvenance(req: http.IncomingMessage): string | null {
  const expectedPort = String(req.socket.localPort);
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string") {
    return "Host header is required";
  }
  const { name, port } = splitHostHeader(hostHeader);
  if (!LOOPBACK_HOST_NAMES.has(name.toLowerCase()) || port !== expectedPort) {
    return `Host header must name loopback on port ${expectedPort}, got "${hostHeader}"`;
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== `http://${hostHeader}`) {
    return `Origin header "${origin}" does not match this server's origin`;
  }

  const secFetchSite = req.headers["sec-fetch-site"];
  if (typeof secFetchSite === "string" && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return `Sec-Fetch-Site "${secFetchSite}" is not same-origin or none`;
  }

  return null;
}

function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Resolves the effective bearer token for a set of options: `null` when
 * `requireAuth` is explicitly `false` (auth disabled), otherwise the
 * caller-supplied `authToken` or a freshly generated one. Called once per
 * server so `startApprovalServer` and the `createApprovalServer` it wraps
 * agree on the same value — `startApprovalServer` resolves it first and
 * passes the concrete token back down.
 */
function resolveAuthToken<TPayload>(options: ApprovalServerOptions<TPayload>): string | null {
  if (options.requireAuth === false) return null;
  return options.authToken ?? generateAuthToken();
}

/** Constant-time string comparison — `timingSafeEqual` requires equal-length buffers. */
function secureStringsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Checks the bearer token against `Authorization: Bearer <token>` first,
 * then a `?token=` query-string fallback — the latter is what lets the
 * built-in HTML page's initial `GET /` (a browser navigation, which can't
 * set custom headers) and a human pasting the printed URL both authenticate.
 * `token === null` means auth is disabled (`requireAuth: false`).
 */
function checkAuthToken(req: http.IncomingMessage, url: URL, token: string | null): string | null {
  if (token === null) return null;

  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const match = /^Bearer (.+)$/.exec(authHeader);
    if (match && secureStringsEqual(match[1]!, token)) return null;
  }

  const queryToken = url.searchParams.get("token");
  if (typeof queryToken === "string" && secureStringsEqual(queryToken, token)) return null;

  return "Missing or invalid bearer token";
}

/** Case-insensitive, ignores a trailing `; charset=...` parameter. */
function hasJsonContentType(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function defaultRender<TPayload>(plan: PendingPlan<TPayload>): RenderablePlan {
  return {
    title: plan.tool,
    details: [{ label: "Payload", value: JSON.stringify(plan.payload, null, 2) }],
  };
}

function renderPlanCard<TPayload>(plan: PendingPlan<TPayload>, renderPlan: RenderPlan<TPayload>): string {
  const rendered = renderPlan(plan);
  const msUntilExpiry = plan.expiresAt - Date.now();
  const secondsLeft = Math.max(0, Math.round(msUntilExpiry / 1000));
  const token = encodeURIComponent(plan.planToken);
  const badge = plan.previewCount !== null ? `${plan.previewCount} affected` : "";
  const title = rendered.title ?? plan.tool;
  const details = rendered.details
    .map(
      (d) => `<dt>${escapeHtml(d.label)}</dt>\n        <dd><pre>${escapeHtml(d.value)}</pre></dd>`,
    )
    .join("\n        ");
  return `
    <article class="plan" data-token="${escapeHtml(plan.planToken)}">
      <header>
        <span class="badge">${escapeHtml(badge)}</span>
        <span class="expiry">expires in ~${secondsLeft}s</span>
      </header>
      <h2>${escapeHtml(title)}</h2>
      <dl>
        <dt>Tool</dt>
        <dd>${escapeHtml(plan.tool)}</dd>
        ${details}
        <dt>Reason given by agent</dt>
        <dd>${plan.reason ? escapeHtml(plan.reason) : "<em>(none given)</em>"}</dd>
      </dl>
      <form class="actions" data-token="${escapeHtml(plan.planToken)}">
        <input type="text" name="actor" placeholder="Your name (optional)" />
        <input type="text" name="reason" placeholder="Rejection reason (optional)" />
        <button type="button" class="approve" data-action="approve" data-token-uri="${token}">Approve</button>
        <button type="button" class="reject" data-action="reject" data-token-uri="${token}">Reject</button>
      </form>
    </article>`;
}

/**
 * Safely embeds a value into an inline `<script>` block as a JS expression:
 * `JSON.stringify` handles quoting/escaping, and the `</` escape stops the
 * token (attacker-supplied, when a host sets `authToken` itself) from
 * closing the surrounding `<script>` tag early.
 */
function jsStringLiteral(value: string | null): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderPage<TPayload>(
  plans: PendingPlan<TPayload>[],
  renderPlan: RenderPlan<TPayload>,
  title: string,
  authToken: string | null,
): string {
  const cards = plans.length > 0
    ? plans.map((p) => renderPlanCard(p, renderPlan)).join("\n")
    : `<p class="empty">No plans are currently awaiting approval.</p>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; line-height: 1.4; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin: 0.5rem 0; }
  .sub { opacity: 0.7; margin-top: -0.5rem; }
  .plan { border: 1px solid #8888; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .plan header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .badge { font-weight: 700; background: #e0a30022; color: #b36b00; padding: 0.15rem 0.6rem; border-radius: 999px; }
  .expiry { opacity: 0.6; font-size: 0.85rem; }
  dt { font-weight: 600; margin-top: 0.6rem; }
  dd { margin: 0.15rem 0 0; }
  pre { background: #8881; padding: 0.5rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap; }
  .actions input { flex: 1; min-width: 10rem; padding: 0.35rem 0.5rem; }
  button { padding: 0.4rem 1rem; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; }
  button.approve { background: #1a7f37; color: white; }
  button.reject { background: #b3261e; color: white; }
  button:disabled { opacity: 0.5; cursor: default; }
  .empty { opacity: 0.7; font-style: italic; }
  #status { margin: 0.5rem 0; min-height: 1.2rem; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">Localhost-only. Approve unlocks the plan for execution; reject permanently kills it.</p>
  <p><button type="button" onclick="location.reload()">Refresh</button></p>
  <div id="status"></div>
  <div id="plans">
    ${cards}
  </div>
  <script>
    const AUTH_TOKEN = ${jsStringLiteral(authToken)};
    document.getElementById("plans").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const tokenUri = btn.getAttribute("data-token-uri");
      const form = btn.closest("form");
      const actor = form.querySelector('input[name="actor"]').value.trim();
      const reasonText = form.querySelector('input[name="reason"]').value.trim();
      const statusEl = document.getElementById("status");
      const allButtons = form.querySelectorAll("button");
      allButtons.forEach((b) => (b.disabled = true));
      statusEl.textContent = action === "approve" ? "Approving..." : "Rejecting...";
      try {
        const body = action === "approve"
          ? { approvedBy: actor || undefined }
          : { rejectedBy: actor || undefined, reason: reasonText || undefined };
        const headers = { "Content-Type": "application/json" };
        if (AUTH_TOKEN) headers["Authorization"] = "Bearer " + AUTH_TOKEN;
        const resp = await fetch("/api/plans/" + tokenUri + "/" + action, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const json = await resp.json();
        if (!resp.ok || json.ok === false) {
          statusEl.textContent = "Failed: " + (json.message || json.code || resp.status);
          allButtons.forEach((b) => (b.disabled = false));
          return;
        }
        statusEl.textContent = action === "approve" ? "Approved." : "Rejected.";
        setTimeout(() => location.reload(), 400);
      } catch (err) {
        statusEl.textContent = "Request failed: " + err;
        allButtons.forEach((b) => (b.disabled = false));
      }
    });
  </script>
</body>
</html>`;
}

function planToJson<TPayload>(
  plan: PendingPlan<TPayload>,
  renderPlan: RenderPlan<TPayload>,
  exposeRawPayload: boolean,
) {
  const rendered = renderPlan(plan);
  return {
    plan_token: plan.planToken,
    tool: plan.tool,
    reason: plan.reason,
    preview_count: plan.previewCount,
    expires_at: plan.expiresAt,
    caller_id: plan.callerId,
    ...(exposeRawPayload ? { payload: plan.payload } : {}),
    render: { title: rendered.title ?? plan.tool, details: rendered.details },
  };
}

export function createApprovalServer<TPayload>(
  store: PlanStore<TPayload>,
  options: ApprovalServerOptions<TPayload> = {},
): http.Server {
  const renderPlan = options.renderPlan ?? defaultRender<TPayload>;
  const title = options.title ?? "Approval queue";
  const onDecision = options.onDecision;
  // Resolved once per server so every request checks against the same
  // value. `startApprovalServer` pre-resolves this itself (passing a
  // concrete `authToken` through `options`) so it can hand the token back
  // on its handle; a direct caller that leaves both `authToken` and
  // `requireAuth` unset gets a token generated here that nothing surfaces.
  const authToken = resolveAuthToken(options);

  return http.createServer((req, res) => {
    void handleRequest(store, renderPlan, title, onDecision, options.exposeRawPayload ?? false, authToken, req, res).catch((err) => {
      // Never leak internal error text to a client — log it server-side and
      // send a stable generic message instead.
      process.stderr.write(`approval server error: ${String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, code: "INTERNAL_ERROR", message: "Internal server error" });
      } else {
        res.end();
      }
    });
  });
}

async function handleRequest<TPayload>(
  store: PlanStore<TPayload>,
  renderPlan: RenderPlan<TPayload>,
  title: string,
  onDecision: ApprovalServerOptions<TPayload>["onDecision"],
  exposeRawPayload: boolean,
  authToken: string | null,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
  const path = url.pathname;

  // Applied to every route, including the read-only GET ones: a page that
  // can read /api/plans has already learned real plan contents, and DNS
  // rebinding can point a hostile page's Host header at this origin.
  const provenanceError = checkRequestProvenance(req);
  if (provenanceError) {
    sendJson(res, 403, { ok: false, code: "FORBIDDEN", message: provenanceError });
    return;
  }

  // Applied to every route too, same reasoning as provenance: loopback bind
  // and the Host/Origin/Sec-Fetch-Site checks above only rule out a
  // browser-driven cross-origin page. A plain HTTP client on the same host
  // that never sends Origin/Sec-Fetch-Site (curl, another local process)
  // sails through those checks with nothing but the plan token — this
  // bearer check is what actually gates "another local process" out. See
  // safe-write-mcp-core#20.
  const authError = checkAuthToken(req, url, authToken);
  if (authError) {
    sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: authError });
    return;
  }

  if (method === "GET" && path === "/") {
    sendHtml(res, 200, renderPage(store.listPending(), renderPlan, title, authToken));
    return;
  }

  if (method === "GET" && path === "/api/plans") {
    sendJson(res, 200, { plans: store.listPending().map((p) => planToJson(p, renderPlan, exposeRawPayload)) });

    return;
  }

  const actionMatch = /^\/api\/plans\/([^/]+)\/(approve|reject)$/.exec(path);
  if (method === "POST" && actionMatch) {
    // Browsers only preflight non-"simple" requests, so a text/plain (or no)
    // Content-Type is enough to let a cross-origin page fire a real POST with
    // no preflight for the browser to block. The provenance check already
    // rejects a mismatched Origin; this is a second, independent gate that
    // also blocks a same-page <form> POST (browsers always send those with no
    // preflight) from masquerading as this JSON API.
    if (!hasJsonContentType(req)) {
      sendJson(res, 415, {
        ok: false,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: 'Content-Type must be "application/json"',
      });
      return;
    }

    let planToken: string;
    try {
      planToken = decodeURIComponent(actionMatch[1]!);
    } catch {
      // A malformed percent-escape in the token segment isn't a server error —
      // it just doesn't name a real route.
      sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: `No route for ${method} ${path}` });
      return;
    }
    const action = actionMatch[2] as "approve" | "reject";
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        // The request body is still streaming in (paused, not consumed).
        // Signal the client not to reuse this connection and tear the socket
        // down once the 413 has flushed.
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
        sendJson(res, 413, {
          ok: false,
          code: "PAYLOAD_TOO_LARGE",
          message: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
        });
        return;
      }
      throw err;
    }

    let decision: ApprovalDecision;
    if (action === "approve") {
      const actor = stringField(body, "approvedBy");
      const result = store.approve(planToken);
      decision = {
        action,
        planToken,
        actor,
        reason: null,
        ok: result.ok,
        already: result.ok && result.alreadyApproved,
        error: result.ok ? null : result.error,
      };
      if (result.ok) {
        sendJson(res, 200, {
          ok: true,
          plan_token: planToken,
          status: "approved",
          approved_by: actor,
          already_approved: result.alreadyApproved,
        });
      } else {
        sendJson(res, statusForErrorCode(result.error.code), {
          ok: false,
          code: result.error.code,
          message: result.error.message,
          hint: result.error.hint ?? null,
        });
      }
    } else {
      const actor = stringField(body, "rejectedBy");
      const reason = stringField(body, "reason");
      const result = store.reject(planToken, reason);
      decision = {
        action,
        planToken,
        actor,
        reason,
        ok: result.ok,
        already: result.ok && result.alreadyRejected,
        error: result.ok ? null : result.error,
      };
      if (result.ok) {
        sendJson(res, 200, {
          ok: true,
          plan_token: planToken,
          status: "rejected",
          rejected_by: actor,
          already_rejected: result.alreadyRejected,
        });
      } else {
        sendJson(res, statusForErrorCode(result.error.code), {
          ok: false,
          code: result.error.code,
          message: result.error.message,
          hint: result.error.hint ?? null,
        });
      }
    }

    if (onDecision) {
      await onDecision(decision);
    }
    return;
  }

  sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: `No route for ${method} ${path}` });
}

/**
 * Starts the localhost approval HTTP server bound to `127.0.0.1` only —
 * never `0.0.0.0` — and separate from the MCP stdio transport. The host
 * starts it alongside its MCP server, sharing the same PlanStore instance so
 * an approval here is visible to `consume()` in the same process (plan tokens
 * are in-memory and process-scoped).
 */
export async function startApprovalServer<TPayload>(
  store: PlanStore<TPayload>,
  options: ApprovalServerOptions<TPayload> = {},
): Promise<ApprovalServerHandle> {
  // Resolved here, once, so it can be returned on the handle — then passed
  // down as a concrete `authToken` so `createApprovalServer`'s own
  // resolution just echoes it back instead of generating a second,
  // different token nobody has.
  const token = resolveAuthToken(options);
  const server = createApprovalServer(store, {
    ...options,
    authToken: token ?? undefined,
    requireAuth: token !== null,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    host: LOOPBACK_HOST,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
