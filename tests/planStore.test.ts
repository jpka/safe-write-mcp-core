import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fingerprint, PlanError, PlanStore } from "../src/index.js";
import type { PendingPlan } from "../src/index.js";

const TTL_MS = 60_000;

function makeStore<T>(ttlMs = TTL_MS): PlanStore<T> {
  return new PlanStore<T>({ planTtlMs: ttlMs });
}

function meta(tool = "test_tool", overrides: Record<string, unknown> = {}) {
  return { tool, ...overrides };
}

describe("fingerprint", () => {
  it("is stable for the same payload", () => {
    expect(fingerprint({ a: 1, b: ["x", "y"] })).toBe(fingerprint({ a: 1, b: ["x", "y"] }));
  });

  it("is independent of object key insertion order", () => {
    const first = { a: 1, b: 2, c: 3 };
    const second: Record<string, unknown> = { c: 3, a: 1, b: 2 };
    expect(fingerprint(first)).toBe(fingerprint(second));
  });

  it("is independent of nested key order", () => {
    const first = { items: [{ id: 1, price: 9.99 }] };
    const second = { items: [{ price: 9.99, id: 1 }] };
    expect(fingerprint(first)).toBe(fingerprint(second));
  });

  it("differs for different payloads", () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 1, b: 1 }));
  });

  it("ignores undefined values", () => {
    expect(fingerprint({ a: undefined, b: 1 })).toBe(fingerprint({ b: 1 }));
  });

  it("honors toJSON (e.g. Date) instead of collapsing to {}", () => {
    expect(fingerprint(new Date(1_700_000_000_000))).toBe(fingerprint(new Date(1_700_000_000_000)));
    expect(fingerprint(new Date(1_700_000_000_000))).not.toBe(fingerprint(new Date(1_700_000_000_001)));
    expect(fingerprint(new Date(1_700_000_000_000))).not.toBe(fingerprint({}));
  });

  it("keeps distinct fingerprints for [undefined], [null], holes, and []", () => {
    const holey: unknown[] = [];
    holey.length = 1; // [ <1 empty item> ]
    expect(fingerprint([undefined])).toBe(fingerprint([null]));
    expect(fingerprint([undefined])).not.toBe(fingerprint([]));
    expect(fingerprint(holey)).toBe(fingerprint([undefined]));
    expect(fingerprint(holey)).not.toBe(fingerprint([]));
  });

  it("does not crash on a top-level undefined payload", () => {
    expect(fingerprint(undefined)).toBe(fingerprint(null));
  });

  it("rejects values that cannot be canonicalized deterministically", () => {
    expect(() => fingerprint(new Map([["a", 1]]))).toThrow(TypeError);
    expect(() => fingerprint(new Set([1, 2]))).toThrow(TypeError);
    expect(() => fingerprint(/a/)).toThrow(TypeError);
    expect(() => fingerprint(10n)).toThrow(TypeError);
    expect(() => fingerprint(Object.assign(new (class C {})(), { a: 1 }))).toThrow(TypeError);
  });
});

describe("PlanStore.create", () => {
  it("issues a fresh token and reports previewed for an ungated plan", () => {
    const store = makeStore();
    const { planToken, status, expiresAt } = store.create({ op: "x" }, meta());
    expect(planToken).toMatch(/^[0-9a-f]{48}$/);
    expect(status).toBe("previewed");
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("reports awaiting_approval when approval is required", () => {
    const store = makeStore();
    const { status } = store.create({ op: "x" }, meta("tool", { approvalRequired: true }));
    expect(status).toBe("awaiting_approval");
  });

  it("alwaysRequireApproval forces awaiting_approval regardless of other flags", () => {
    const store = makeStore();
    const { status } = store.create({ op: "x" }, meta("tool", { alwaysRequireApproval: true }));
    expect(status).toBe("awaiting_approval");
  });

  it("generates unique tokens", () => {
    const store = makeStore();
    const a = store.create({}, meta()).planToken;
    const b = store.create({}, meta()).planToken;
    expect(a).not.toBe(b);
  });
});

describe("PlanStore.consume", () => {
  it("succeeds once for a matching, ungated plan", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    const first = store.consume(planToken, { op: "x" });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.meta.tool).toBe("test_tool");
    }
    const second = store.consume(planToken, { op: "x" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBeInstanceOf(PlanError);
      expect(second.error.code).toBe("PLAN_USED");
    }
  });

  it("refuses a payload that does not match the plan", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    const result = store.consume(planToken, { op: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_MISMATCH");
    }
  });

  it("refuses an unknown token", () => {
    const store = makeStore();
    const result = store.consume("deadbeef", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_TOKEN");
    }
  });

  it("refuses an expired token and does not mark it used", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta());
      vi.advanceTimersByTime(TTL_MS + 1);
      const result = store.consume(planToken, { op: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PLAN_EXPIRED");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an unapproved gated plan with AWAITING_APPROVAL and keeps it pending", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta("tool", { approvalRequired: true }));
    const result = store.consume(planToken, { op: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AWAITING_APPROVAL");
    }
    expect(store.listPending()).toHaveLength(1);
  });

  it("succeeds for a gated plan after approval", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta("tool", { approvalRequired: true }));
    store.approve(planToken);
    const result = store.consume(planToken, { op: "x" });
    expect(result.ok).toBe(true);
  });

  it("reports a permanent PLAN_REJECTED for a rejected plan, before any other check", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    store.reject(planToken, "too broad");
    // Wrong payload on purpose: rejection must win over fingerprint mismatch.
    const result = store.consume(planToken, { op: "wrong" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_REJECTED");
      expect(result.error.message).toContain("too broad");
    }
  });

  it("still reports PLAN_REJECTED after the token would have expired", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta());
      store.reject(planToken, null);
      vi.advanceTimersByTime(TTL_MS * 10);
      const result = store.consume(planToken, { op: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PLAN_REJECTED");
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PlanStore.approve", () => {
  it("is idempotent", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta("tool", { approvalRequired: true }));
    const first = store.approve(planToken);
    expect(first.ok).toBe(true);
    const second = store.approve(planToken);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.alreadyApproved).toBe(true);
    }
  });

  it("cannot approve a rejected plan", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta("tool", { approvalRequired: true }));
    store.reject(planToken, null);
    const result = store.approve(planToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_REJECTED");
    }
  });

  it("cannot approve a used plan", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    store.consume(planToken, { op: "x" });
    const result = store.approve(planToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_USED");
    }
  });

  it("cannot approve an expired plan", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta("tool", { approvalRequired: true }));
      vi.advanceTimersByTime(TTL_MS + 1);
      const result = store.approve(planToken);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PLAN_EXPIRED");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports UNKNOWN_TOKEN for a token that never existed", () => {
    const store = makeStore();
    const result = store.approve("deadbeef");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_TOKEN");
    }
  });
});

describe("PlanStore.reject", () => {
  it("is idempotent and keeps the first reason", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    const first = store.reject(planToken, "too broad");
    expect(first.ok).toBe(true);
    expect(first.alreadyRejected).toBe(false);
    const second = store.reject(planToken, "revised");
    expect(second.ok).toBe(true);
    expect(second.alreadyRejected).toBe(true);
    const consume = store.consume(planToken, { op: "x" });
    if (!consume.ok) {
      expect(consume.error.message).toContain("too broad");
    }
  });

  it("cannot reject a used plan", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    store.consume(planToken, { op: "x" });
    const result = store.reject(planToken, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_USED");
    }
  });

  it("reports UNKNOWN_TOKEN for a token that never existed", () => {
    const store = makeStore();
    const result = store.reject("deadbeef", null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_TOKEN");
    }
  });
});

describe("PlanStore.listPending", () => {
  it("lists only gated, unapproved, unused, unexpired plans", () => {
    const store = makeStore();
    const { planToken: gated } = store.create({ id: "a" }, meta("t1", { approvalRequired: true }));
    store.create({ id: "b" }, meta("t2"));
    const { planToken: approvedToken } = store.create(
      { id: "c" },
      meta("t3", { approvalRequired: true }),
    );
    store.approve(approvedToken);
    const { planToken: rejectedToken } = store.create(
      { id: "d" },
      meta("t4", { approvalRequired: true }),
    );
    store.reject(rejectedToken, null);
    const { planToken: usedToken } = store.create({ id: "e" }, meta("t5", { approvalRequired: true }));
    store.approve(usedToken);
    store.consume(usedToken, { id: "e" });

    const pending = store.listPending();
    expect(pending.map((p) => p.planToken)).toEqual([gated]);
  });

  it("sorts soonest-expiring first", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const tokens: string[] = [];
      for (let i = 0; i < 3; i++) {
        tokens.push(store.create({ i }, meta("t", { approvalRequired: true })).planToken);
        vi.advanceTimersByTime(1);
      }
      expect(store.listPending().map((plan) => plan.planToken)).toEqual(tokens);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries payload, reason, previewCount, and extra for rendering", () => {
    const store = makeStore();
    store.create(
      { items: [{ id: 1, before: 1, after: 2 }] },
      meta("update_prices", {
        reason: "repricing sale items",
        previewCount: 42,
        approvalRequired: true,
        extra: { target: "public.products" },
      }),
    );
    const pending: PendingPlan<{ items: unknown[] }>[] = store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe("repricing sale items");
    expect(pending[0].previewCount).toBe(42);
    expect(pending[0].extra).toEqual({ target: "public.products" });
    expect(pending[0].payload.items).toHaveLength(1);
  });

  it("omits expired plans", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      store.create({ id: "a" }, meta("t", { approvalRequired: true }));
      vi.advanceTimersByTime(TTL_MS + 1);
      expect(store.listPending()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PlanStore.sweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes expired and used entries but keeps rejected tombstones", () => {
    const store = makeStore();
    const { planToken: expiring } = store.create({ id: "a" }, meta());
    const { planToken: usable } = store.create({ id: "b" }, meta());
    const { planToken: rejectedToken } = store.create({ id: "c" }, meta());
    store.reject(rejectedToken, null);
    store.consume(usable, { id: "b" });
    vi.advanceTimersByTime(TTL_MS + 1);
    store.sweep();
    // expiring: expired -> gone; usable: used -> gone; rejectedToken: tombstone kept.
    const expired = store.consume(expiring, { id: "a" });
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.error.code).toBe("UNKNOWN_TOKEN");
    }

    const used = store.consume(usable, { id: "b" });
    expect(used.ok).toBe(false);
    if (!used.ok) {
      expect(used.error.code).toBe("UNKNOWN_TOKEN");
    }

    const afterSweep = store.consume(rejectedToken, { id: "c" });
    expect(afterSweep.ok).toBe(false);
    if (!afterSweep.ok) {
      expect(afterSweep.error.code).toBe("PLAN_REJECTED");
    }
  });
});
