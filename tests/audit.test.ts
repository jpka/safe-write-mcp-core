import { describe, expect, it, vi } from "vitest";

import { NoopSink, PlanStore } from "../src/index.js";
import type { AuditEvent, AuditSink } from "../src/index.js";

type Payload = { op: string };

function makeStore(audit?: AuditSink, ttlMs = 60_000): PlanStore<Payload> {
  return new PlanStore<Payload>({ planTtlMs: ttlMs, audit });
}

function collect(events: AuditEvent[]): AuditSink {
  return { record: (e) => events.push(e) };
}

describe("AuditSink lifecycle events", () => {
  it("emits previewed on create of an ungated plan", () => {
    const events: AuditEvent[] = [];
    const store = makeStore(collect(events));
    const { planToken } = store.create({ op: "x" }, { tool: "t", reason: "r", previewCount: 3 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "t",
      reason: "r",
      planToken,
      status: "previewed",
      previewCount: 3,
      callerId: "unknown",
    });
  });

  it("emits awaiting_approval on create of a gated plan", () => {
    const events: AuditEvent[] = [];
    const store = makeStore(collect(events));
    store.create({ op: "x" }, { tool: "t", approvalRequired: true, callerId: "deploy-a" });
    expect(events[0].status).toBe("awaiting_approval");
    expect(events[0].callerId).toBe("deploy-a");
  });

  it("emits approved on a successful approve, failed on a refusal", () => {
    const events: AuditEvent[] = [];
    const store = makeStore(collect(events));
    const { planToken } = store.create({ op: "x" }, { tool: "t", approvalRequired: true });

    const ok = store.approve(planToken);
    expect(ok.ok).toBe(true);
    const refused = store.approve("does-not-exist");
    expect(refused.ok).toBe(false);

    const statuses = events.map((e) => e.status);
    expect(statuses).toEqual(["awaiting_approval", "approved", "failed"]);
    expect(events[2].detail).toContain("UNKNOWN_TOKEN");
    expect(events[2].planToken).toBe("does-not-exist");
  });

  it("emits rejected on a successful reject, failed on a refusal", () => {
    const events: AuditEvent[] = [];
    const store = makeStore(collect(events));
    const { planToken } = store.create({ op: "x" }, { tool: "t", approvalRequired: true });

    store.reject(planToken, "too broad");
    store.reject("does-not-exist", null);

    expect(events.map((e) => e.status)).toEqual(["awaiting_approval", "rejected", "failed"]);
  });

  it("emits executed on a successful consume, failed on every gate refusal", () => {
    const events: AuditEvent[] = [];
    const store = makeStore(collect(events));
    const { planToken } = store.create({ op: "x" }, { tool: "t" });

    // Wrong payload -> PLAN_MISMATCH (failed).
    store.consume(planToken, { op: "different" });
    // Correct payload -> executed (token spent).
    const consumed = store.consume(planToken, { op: "x" });
    expect(consumed.ok).toBe(true);
    // Reusing the spent token -> PLAN_USED (failed).
    store.consume(planToken, { op: "x" });

    expect(events.map((e) => e.status)).toEqual(["previewed", "failed", "executed", "failed"]);
    expect(events[1].detail).toContain("PLAN_MISMATCH");
    expect(events[3].detail).toContain("PLAN_USED");
  });

  it("records durationMs and a ts on every event", () => {
    const events: AuditEvent[] = [];
    const store = makeStore(collect(events));
    store.create({ op: "x" }, { tool: "t" });
    expect(events[0].ts).toBeGreaterThan(0);
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("NoopSink default", () => {
  it("is used when no audit sink is configured and never throws", () => {
    const store = makeStore();
    expect(() => {
      store.create({ op: "x" }, { tool: "t" });
      store.consume("nope", { op: "x" });
    }).not.toThrow();
    expect(NoopSink.record).toBeDefined();
  });
});

describe("audit sink failure isolation", () => {
  it("a throwing sink never breaks a plan transition", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const throwing: AuditSink = {
        record() {
          throw new Error("disk full");
        },
      };
      const store = makeStore(throwing);
      // create emits -> sink throws -> swallowed; store still works.
      const { planToken } = store.create({ op: "x" }, { tool: "t" });
      expect(store.consume(planToken, { op: "x" }).ok).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
