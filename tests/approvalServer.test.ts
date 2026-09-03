import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PlanStore, startApprovalServer } from "../src/index.js";
import type { ApprovalServerHandle, ApprovalDecision, PendingPlan } from "../src/index.js";

type Payload = { op: string; items?: Array<{ id: number; before: number; after: number }> };

const TTL_MS = 60_000;

function makeStore(ttlMs = TTL_MS): PlanStore<Payload> {
  return new PlanStore<Payload>({ planTtlMs: ttlMs });
}

function createGatedPlan(store: PlanStore<Payload>, op = "reprice", reason = "sale"): string {
  return store.create({ op, items: [{ id: 1, before: 10, after: 9 }] }, {
    tool: "update_prices",
    reason,
    previewCount: 1,
    approvalRequired: true,
    extra: { target: "products" },
  }).planToken;
}

const renderPlan = (plan: PendingPlan<Payload>) => ({
  title: `${plan.tool}: ${plan.payload.op}`,
  details: (plan.payload.items ?? []).map((i) => ({
    label: `item ${i.id}`,
    value: `${i.before} -> ${i.after}`,
  })),
});

/** `Authorization` header carrying the server's bearer token, for a normal `fetch()` call. */
function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Sends a raw HTTP request with full control over headers — including `Host`,
 * which the Fetch spec forbids scripts from setting and Node's fetch()
 * overwrites with the URL's own authority. Needed to exercise the
 * CSRF-hardening request-provenance checks.
 */
function rawRequest(
  url: string,
  options: http.RequestOptions & { body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString("utf-8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe("approval server", () => {
  let store: PlanStore<Payload>;
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    store = makeStore();
    approval = await startApprovalServer(store, { renderPlan });
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await approval?.close().catch(() => {});
  });

  it("binds to 127.0.0.1 only, never 0.0.0.0", () => {
    expect(approval.host).toBe("127.0.0.1");
    const address = approval.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");
    const info = address as import("node:net").AddressInfo;
    expect(info.address).toBe("127.0.0.1");
  });

  it("lists a pending plan on GET /api/plans with rendered field but NO raw payload", async () => {
    const token = createGatedPlan(store, "reprice", "marking down sale items");
    const resp = await fetch(`${baseUrl}/api/plans`, { headers: authHeaders(approval.token) });
    expect(resp.status).toBe(200);
    const { plans } = (await resp.json()) as {
      plans: Array<Record<string, unknown> & { payload?: Payload; render: Record<string, unknown> }>;
    };
    const mine = plans.find((p) => p.plan_token === token);
    expect(mine).toBeDefined();
    expect(mine!.tool).toBe("update_prices");
    expect(mine!.reason).toBe("marking down sale items");
    expect(mine!.preview_count).toBe(1);
    expect(mine!.payload).toBeUndefined();
    expect(mine!.render).toEqual({
      title: "update_prices: reprice",
      details: [{ label: "item 1", value: "10 -> 9" }],
    });
  });

  it("excludes raw payload from GET /api/plans even when renderPlan surfaces nothing sensitive", async () => {
    const token = createGatedPlan(store, "secret-op", "testing redaction");
    const resp = await fetch(`${baseUrl}/api/plans`, { headers: authHeaders(approval.token) });
    expect(resp.status).toBe(200);
    const { plans } = (await resp.json()) as { plans: Array<Record<string, unknown>> };
    const mine = plans.find((p) => p.plan_token === token);
    expect(mine).toBeDefined();
    expect("payload" in mine!).toBe(false);
    expect("render" in mine!).toBe(true);
  });

  it("includes raw payload on GET /api/plans only when exposeRawPayload is true", async () => {
    const rawStore = makeStore();
    const rawApproval = await startApprovalServer(rawStore, { renderPlan, exposeRawPayload: true });
    const rawBaseUrl = `http://${rawApproval.host}:${rawApproval.port}`;
    try {
      const token = createGatedPlan(rawStore, "reprice", "raw-payload-opt-in");
      const resp = await fetch(`${rawBaseUrl}/api/plans`, { headers: authHeaders(rawApproval.token) });
      expect(resp.status).toBe(200);
      const { plans } = (await resp.json()) as {
        plans: Array<Record<string, unknown> & { payload: Payload }>;
      };
      const mine = plans.find((p) => p.plan_token === token);
      expect(mine).toBeDefined();
      expect(mine!.payload).toEqual({ op: "reprice", items: [{ id: 1, before: 10, after: 9 }] });
      expect(mine!.render).toEqual({
        title: "update_prices: reprice",
        details: [{ label: "item 1", value: "10 -> 9" }],
      });
      expect(Object.keys(mine!).sort()).toEqual([
        "caller_id",
        "expires_at",
        "payload",
        "plan_token",
        "preview_count",
        "reason",
        "render",
        "tool",
      ]);
    } finally {
      await rawApproval.close();
    }
  });

  it("renders the HTML page with the reason, tool, and badge", async () => {
    createGatedPlan(store, "reprice", "html-visibility-check");
    const resp = await fetch(`${baseUrl}/`, { headers: authHeaders(approval.token) });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/text\/html/);
    const html = await resp.text();
    expect(html).toContain("html-visibility-check");
    expect(html).toContain("update_prices");
    expect(html).toContain("1 affected");
  });

  it("embeds the bearer token in the HTML page so its own fetch calls authenticate", async () => {
    const resp = await fetch(`${baseUrl}/`, { headers: authHeaders(approval.token) });
    const html = await resp.text();
    expect(html).toContain(`const AUTH_TOKEN = ${JSON.stringify(approval.token)};`);
  });

  it("approve unlocks the plan so consume() succeeds", async () => {
    const token = createGatedPlan(store, "approve-me");
    const resp = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(token)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
      body: JSON.stringify({ approvedBy: "reviewer@example.com" }),
    });
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { ok: boolean }).ok).toBe(true);

    // Approved plan drops off the pending list.
    const { plans } = (await (
      await fetch(`${baseUrl}/api/plans`, { headers: authHeaders(approval.token) })
    ).json()) as {
      plans: Array<{ plan_token: string }>;
    };
    expect(plans.find((p) => p.plan_token === token)).toBeUndefined();

    const consumed = store.consume(token, { op: "approve-me", items: [{ id: 1, before: 10, after: 9 }] });
    expect(consumed.ok).toBe(true);
  });

  it("approving an unknown token is a structured 404", async () => {
    const resp = await fetch(`${baseUrl}/api/plans/not-a-real-token/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
      body: "{}",
    });
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("UNKNOWN_TOKEN");
  });

  it("reject permanently kills the plan; approve-after-reject is a 409", async () => {
    const token = createGatedPlan(store, "reject-me");
    const rejectResp = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(token)}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
      body: JSON.stringify({ rejectedBy: "reviewer@example.com", reason: "too broad" }),
    });
    expect(rejectResp.status).toBe(200);
    expect(((await rejectResp.json()) as { ok: boolean }).ok).toBe(true);

    // consume() against the rejected plan reports PLAN_REJECTED with the reason.
    const consumed = store.consume(token, { op: "reject-me", items: [{ id: 1, before: 10, after: 9 }] });
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) {
      expect(consumed.error.code).toBe("PLAN_REJECTED");
      expect(consumed.error.message).toContain("too broad");
    }

    const approveAfter = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(token)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
      body: "{}",
    });
    expect(approveAfter.status).toBe(409);
    const json = (await approveAfter.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("PLAN_REJECTED");
  });

  it("rejecting twice is idempotent and reports already_rejected", async () => {
    const token = createGatedPlan(store, "reject-twice");
    const first = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(token)}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
      body: JSON.stringify({ reason: "first reason" }),
    });
    expect(((await first.json()) as { ok: boolean; already_rejected: boolean }).already_rejected).toBe(false);

    const second = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(token)}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
      body: JSON.stringify({ reason: "second reason" }),
    });
    expect(second.status).toBe(200);
    const json = (await second.json()) as { ok: boolean; already_rejected: boolean };
    expect(json.ok).toBe(true);
    expect(json.already_rejected).toBe(true);
  });

  it("an ungated plan never appears on the pending list", async () => {
    const { planToken } = store.create({ op: "below-threshold" }, { tool: "update_prices" });
    const { plans } = (await (
      await fetch(`${baseUrl}/api/plans`, { headers: authHeaders(approval.token) })
    ).json()) as {
      plans: Array<{ plan_token: string }>;
    };
    expect(plans.find((p) => p.plan_token === planToken)).toBeUndefined();
  });

  it("returns a structured 404 for an unknown route", async () => {
    const resp = await fetch(`${baseUrl}/nope`, { headers: authHeaders(approval.token) });
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("NOT_FOUND");
  });

  it("returns 404, not 500, for a malformed percent-escape in the token segment", async () => {
    const resp = await fetch(`${baseUrl}/api/plans/%E0%A4%A/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
      body: "{}",
    });
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("NOT_FOUND");
  });

  it("sets Cache-Control: no-store on both JSON and HTML responses", async () => {
    expect(
      (await fetch(`${baseUrl}/api/plans`, { headers: authHeaders(approval.token) })).headers.get("cache-control"),
    ).toBe("no-store");
    expect((await fetch(`${baseUrl}/`, { headers: authHeaders(approval.token) })).headers.get("cache-control")).toBe(
      "no-store",
    );
  });
});

describe("approval server: bearer-token authentication", () => {
  let store: PlanStore<Payload>;
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    store = makeStore();
    approval = await startApprovalServer(store, { renderPlan });
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await approval?.close().catch(() => {});
  });

  it("generates a token by default and returns it on the handle", () => {
    expect(typeof approval.token).toBe("string");
    expect(approval.token!.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects GET /api/plans with no token at all", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`);
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("rejects GET /api/plans with a wrong Authorization bearer token", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, { headers: { Authorization: "Bearer not-the-token" } });
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("accepts the correct token via the Authorization header", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, { headers: { Authorization: `Bearer ${approval.token}` } });
    expect(resp.status).toBe(200);
  });

  it("accepts the correct token via a ?token= query-string fallback", async () => {
    const resp = await fetch(`${baseUrl}/api/plans?token=${encodeURIComponent(approval.token!)}`);
    expect(resp.status).toBe(200);
  });

  it("rejects a wrong ?token= query-string value", async () => {
    const resp = await fetch(`${baseUrl}/api/plans?token=wrong`);
    expect(resp.status).toBe(401);
  });

  it("rejects an unauthenticated POST /api/plans/:token/approve — the plan token alone is not enough", async () => {
    const token = createGatedPlan(store, "unauthenticated-approve-attempt");
    const resp = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(token)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { code: string }).code).toBe("UNAUTHORIZED");

    // The plan is untouched — a correctly authenticated approve still works.
    const approved = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(token)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${approval.token}` },
      body: "{}",
    });
    expect(approved.status).toBe(200);
  });

  it("rejects an unauthenticated GET / (the approval page itself)", async () => {
    const resp = await fetch(`${baseUrl}/`);
    expect(resp.status).toBe(401);
  });

  it("serves GET / when the token is passed as a query string", async () => {
    const resp = await fetch(`${baseUrl}/?token=${encodeURIComponent(approval.token!)}`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/text\/html/);
  });
});

describe("approval server: requireAuth: false opt-out", () => {
  let store: PlanStore<Payload>;
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    store = makeStore();
    approval = await startApprovalServer(store, { renderPlan, requireAuth: false });
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await approval?.close().catch(() => {});
  });

  it("returns null on the handle's token", () => {
    expect(approval.token).toBeNull();
  });

  it("serves an unauthenticated request when auth is disabled", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`);
    expect(resp.status).toBe(200);
  });
});

describe("approval server: caller-supplied authToken", () => {
  it("accepts a host-supplied authToken instead of generating one", async () => {
    const store = makeStore();
    const approval = await startApprovalServer(store, { renderPlan, authToken: "my-own-secret" });
    const baseUrl = `http://${approval.host}:${approval.port}`;
    try {
      expect(approval.token).toBe("my-own-secret");
      const resp = await fetch(`${baseUrl}/api/plans`, { headers: { Authorization: "Bearer my-own-secret" } });
      expect(resp.status).toBe(200);
      const rejected = await fetch(`${baseUrl}/api/plans`, { headers: { Authorization: "Bearer generated" } });
      expect(rejected.status).toBe(401);
    } finally {
      await approval.close();
    }
  });

  it("treats an empty-string authToken as omitted rather than as a usable secret", async () => {
    const store = makeStore();
    const approval = await startApprovalServer(store, { renderPlan, authToken: "" });
    const baseUrl = `http://${approval.host}:${approval.port}`;
    try {
      // A generated token was used instead of the empty string.
      expect(approval.token).toBeTruthy();
      expect(approval.token).not.toBe("");

      // An empty `?token=` (no value given at all) must NOT authenticate.
      const resp = await fetch(`${baseUrl}/api/plans?token=`);
      expect(resp.status).toBe(401);

      // The real generated token still works.
      const authed = await fetch(`${baseUrl}/api/plans?token=${encodeURIComponent(approval.token!)}`);
      expect(authed.status).toBe(200);
    } finally {
      await approval.close();
    }
  });
});

describe("approval server: request-provenance hardening", () => {
  let store: PlanStore<Payload>;
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    store = makeStore();
    approval = await startApprovalServer(store, { renderPlan });
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await approval?.close().catch(() => {});
  });

  it("rejects a Host header that doesn't match the actual bound port", async () => {
    const result = await rawRequest(`${baseUrl}/api/plans`, {
      method: "GET",
      headers: { Host: "evil.example.com", Authorization: `Bearer ${approval.token}` },
    });
    expect(result.status).toBe(403);
    expect((JSON.parse(result.body) as { code: string }).code).toBe("FORBIDDEN");
  });

  it("accepts localhost as a Host header name on the bound port", async () => {
    const result = await rawRequest(`${baseUrl}/api/plans`, {
      method: "GET",
      headers: { Host: `localhost:${approval.port}`, Authorization: `Bearer ${approval.token}` },
    });
    expect(result.status).toBe(200);
  });

  it("accepts localhost as a Host name with a matching Origin", async () => {
    const result = await rawRequest(`${baseUrl}/api/plans`, {
      method: "GET",
      headers: {
        Host: `localhost:${approval.port}`,
        Origin: `http://localhost:${approval.port}`,
        Authorization: `Bearer ${approval.token}`,
      },
    });
    expect(result.status).toBe(200);
  });

  it("still rejects a loopback Host name on the wrong port", async () => {
    const result = await rawRequest(`${baseUrl}/api/plans`, {
      method: "GET",
      headers: { Host: "localhost:1", Authorization: `Bearer ${approval.token}` },
    });
    expect(result.status).toBe(403);
  });

  it("checks provenance ahead of auth: a bad Host header is 403 even with no token", async () => {
    const result = await rawRequest(`${baseUrl}/api/plans`, {
      method: "GET",
      headers: { Host: "evil.example.com" },
    });
    expect(result.status).toBe(403);
  });

  it("rejects an Origin header that doesn't match this server's origin", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, {
      headers: { Origin: "http://evil.example.com", ...authHeaders(approval.token) },
    });
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as { code: string }).code).toBe("FORBIDDEN");
  });

  it("rejects Sec-Fetch-Site: cross-site", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, {
      headers: { "Sec-Fetch-Site": "cross-site", ...authHeaders(approval.token) },
    });
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as { code: string }).code).toBe("FORBIDDEN");
  });

  it("rejects a POST whose Content-Type isn't application/json", async () => {
    const token = createGatedPlan(store, "content-type-check");
    const resp = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(token)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...authHeaders(approval.token) },
      body: "{}",
    });
    expect(resp.status).toBe(415);
    expect(((await resp.json()) as { code: string }).code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects a POST with no Content-Type at all", async () => {
    const token = createGatedPlan(store, "no-content-type-check");
    const result = await rawRequest(`${baseUrl}/api/plans/${encodeURIComponent(token)}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${approval.token}` },
      body: "{}",
    });
    expect(result.status).toBe(415);
    expect((JSON.parse(result.body) as { code: string }).code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects an oversized request body with 413, not 500", async () => {
    const token = createGatedPlan(store, "oversized-body-check");
    const oversized = JSON.stringify({ approvedBy: "x".repeat(70 * 1024) });
    const result = await rawRequest(`${baseUrl}/api/plans/${encodeURIComponent(token)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${approval.token}` },
      body: oversized,
    });
    expect(result.status).toBe(413);
    const parsed = JSON.parse(result.body) as { code: string; message: string };
    expect(parsed.code).toBe("PAYLOAD_TOO_LARGE");
    expect(parsed.message).not.toContain("x".repeat(10));
  });

  it("still serves a legitimate request whose Origin matches the server's own origin", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, { headers: { Origin: baseUrl, ...authHeaders(approval.token) } });
    expect(resp.status).toBe(200);
  });

  it("still serves a legitimate request with Sec-Fetch-Site: same-origin or none", async () => {
    expect(
      (
        await fetch(`${baseUrl}/api/plans`, {
          headers: { "Sec-Fetch-Site": "same-origin", ...authHeaders(approval.token) },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/api/plans`, {
          headers: { "Sec-Fetch-Site": "none", ...authHeaders(approval.token) },
        })
      ).status,
    ).toBe(200);
  });
});

describe("approval server: expiry and onDecision hook", () => {
  it("an expired plan disappears from the list and approving it is a 410", async () => {
    const store = makeStore(30);
    const approval = await startApprovalServer(store, { renderPlan });
    const baseUrl = `http://${approval.host}:${approval.port}`;
    try {
      const token = createGatedPlan(store, "expiring");
      const before = (await (
        await fetch(`${baseUrl}/api/plans`, { headers: authHeaders(approval.token) })
      ).json()) as {
        plans: Array<{ plan_token: string }>;
      };
      expect(before.plans.find((p) => p.plan_token === token)).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 60));

      const after = (await (
        await fetch(`${baseUrl}/api/plans`, { headers: authHeaders(approval.token) })
      ).json()) as {
        plans: Array<{ plan_token: string }>;
      };
      expect(after.plans.find((p) => p.plan_token === token)).toBeUndefined();

      const approveResp = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(token)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
        body: "{}",
      });
      expect(approveResp.status).toBe(410);
      expect(((await approveResp.json()) as { code: string }).code).toBe("PLAN_EXPIRED");
    } finally {
      await approval.close();
    }
  });

  it("invokes onDecision for successful approve and reject with actor and outcome", async () => {
    const store = makeStore();
    const decisions: ApprovalDecision[] = [];
    const approval = await startApprovalServer(store, {
      renderPlan,
      onDecision: (d) => {
        decisions.push(d);
      },
    });
    const baseUrl = `http://${approval.host}:${approval.port}`;
    try {
      const approveToken = createGatedPlan(store, "decision-approve");
      await fetch(`${baseUrl}/api/plans/${encodeURIComponent(approveToken)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
        body: JSON.stringify({ approvedBy: "alice" }),
      });

      const rejectToken = createGatedPlan(store, "decision-reject");
      await fetch(`${baseUrl}/api/plans/${encodeURIComponent(rejectToken)}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
        body: JSON.stringify({ rejectedBy: "bob", reason: "nope" }),
      });

      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toMatchObject({
        action: "approve",
        planToken: approveToken,
        actor: "alice",
        ok: true,
      });
      expect(decisions[1]).toMatchObject({
        action: "reject",
        planToken: rejectToken,
        actor: "bob",
        reason: "nope",
        ok: true,
      });
    } finally {
      await approval.close();
    }
  });

  it("invokes onDecision for a failed approve (unknown token) with the error", async () => {
    const store = makeStore();
    const decisions: ApprovalDecision[] = [];
    const approval = await startApprovalServer(store, { onDecision: (d) => decisions.push(d) });
    const baseUrl = `http://${approval.host}:${approval.port}`;
    try {
      await fetch(`${baseUrl}/api/plans/nope/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(approval.token) },
        body: "{}",
      });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].ok).toBe(false);
      expect(decisions[0].error?.code).toBe("UNKNOWN_TOKEN");
    } finally {
      await approval.close();
    }
  });

  it("falls back to a JSON dump of the payload when no renderPlan is provided", async () => {
    const store = makeStore();
    const approval = await startApprovalServer(store);
    const baseUrl = `http://${approval.host}:${approval.port}`;
    try {
      const token = createGatedPlan(store, "default-render");
      const { plans } = (await (
        await fetch(`${baseUrl}/api/plans`, { headers: authHeaders(approval.token) })
      ).json()) as {
        plans: Array<{ render: { title: string; details: Array<{ label: string }> } }>;
      };
      const mine = plans.find((p) => p.render.title === "update_prices");
      expect(mine).toBeDefined();
      expect(mine!.render.details[0].label).toBe("Payload");
      void token;
    } finally {
      await approval.close();
    }
  });
});
