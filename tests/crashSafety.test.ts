import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlanError, PlanStore, replayJournal } from "../src/index.js";
import type { AuditEvent, AuditSink, ReconcileOutcome } from "../src/index.js";

const TTL_MS = 60_000;

type Payload = { op: string };

function meta(tool = "test_tool", overrides: Record<string, unknown> = {}) {
  return { tool, ...overrides };
}

function collect(events: AuditEvent[]): AuditSink {
  return {
    record(e) {
      events.push(e);
      return undefined;
    },
  };
}

function makeStore<T = Payload>(
  opts: Partial<{
    planTtlMs: number;
    journalPath: string;
    audit: AuditSink;
    reconcile: (t: string) => ReconcileOutcome | Promise<ReconcileOutcome>;
  }> = {},
): PlanStore<T> {
  const { planTtlMs = TTL_MS, ...rest } = opts;
  return new PlanStore<T>({ planTtlMs, ...rest });
}

function readJournal(path: string): Record<string, unknown>[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("beginExecute", () => {
  it("moves a plan to executing without marking it used and without emitting executed", () => {
    const events: AuditEvent[] = [];
    const store = makeStore({ audit: collect(events) });
    const { planToken } = store.create({ op: "x" }, meta());

    const result = store.beginExecute(planToken, { op: "x" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.tool).toBe("test_tool");
    }
    expect(store.listExecuting()).toHaveLength(1);
    expect(store.listExecuting()[0].planToken).toBe(planToken);

    const statuses = events.map((e) => e.status);
    expect(statuses).toEqual(["previewed", "executing"]);

    // The plan is NOT used yet: a second begin is ALREADY_EXECUTING, not PLAN_USED.
    const again = store.beginExecute(planToken, { op: "x" });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("ALREADY_EXECUTING");
    }
  });

  it("refuses an unknown token", () => {
    const store = makeStore();
    const result = store.beginExecute("deadbeef", { op: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_TOKEN");
    }
  });

  describe("gate ordering (rejected wins over everything, etc.)", () => {
    it("reports a permanent PLAN_REJECTED before any other check", () => {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta());
      store.reject(planToken, "too broad");
      // Wrong payload on purpose: rejection must win over fingerprint mismatch.
      const result = store.beginExecute(planToken, { op: "wrong" });
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
        const result = store.beginExecute(planToken, { op: "x" });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("PLAN_REJECTED");
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports PLAN_USED for a token that already executed", () => {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta());
      store.beginExecute(planToken, { op: "x" });
      store.confirmExecuted(planToken);
      const result = store.beginExecute(planToken, { op: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PLAN_USED");
      }
    });

    it("refuses an expired token and does not mark it used", () => {
      vi.useFakeTimers();
      try {
        const store = makeStore();
        const { planToken } = store.create({ op: "x" }, meta());
        vi.advanceTimersByTime(TTL_MS + 1);
        const result = store.beginExecute(planToken, { op: "x" });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("PLAN_EXPIRED");
        }
        expect(store.listExecuting()).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses a payload that does not match the plan", () => {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta());
      const result = store.beginExecute(planToken, { op: "y" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PLAN_MISMATCH");
      }
    });

    it("refuses an unapproved gated plan with AWAITING_APPROVAL and keeps it pending", () => {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta("tool", { approvalRequired: true }));
      const result = store.beginExecute(planToken, { op: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("AWAITING_APPROVAL");
      }
      expect(store.listPending()).toHaveLength(1);
      expect(store.listExecuting()).toHaveLength(0);
    });

    it("succeeds for a gated plan after approval", () => {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta("tool", { approvalRequired: true }));
      store.approve(planToken);
      const result = store.beginExecute(planToken, { op: "x" });
      expect(result.ok).toBe(true);
    });
  });
});

describe("confirmExecuted", () => {
  it("marks the plan used and emits executed only here", () => {
    const events: AuditEvent[] = [];
    const store = makeStore({ audit: collect(events) });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });
    expect(events.map((e) => e.status)).toEqual(["previewed", "executing"]);

    const result = store.confirmExecuted(planToken);
    expect(result.ok).toBe(true);
    expect(store.listExecuting()).toHaveLength(0);
    expect(events.map((e) => e.status)).toEqual(["previewed", "executing", "executed"]);
  });

  it("errors with NOT_EXECUTING for a token that never began", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    const result = store.confirmExecuted(planToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_EXECUTING");
    }
  });

  it("errors with NOT_EXECUTING for a token already confirmed", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });
    store.confirmExecuted(planToken);
    const second = store.confirmExecuted(planToken);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("NOT_EXECUTING");
    }
  });

  it("errors with UNKNOWN_TOKEN for a token that never existed", () => {
    const store = makeStore();
    const result = store.confirmExecuted("deadbeef");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_TOKEN");
    }
  });

  it("still works for an executing token that is past its TTL", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta());
      store.beginExecute(planToken, { op: "x" });
      vi.advanceTimersByTime(TTL_MS * 10);
      const result = store.confirmExecuted(planToken);
      expect(result.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("confirmFailed", () => {
  it("releases a plan back to retryable: not used, can beginExecute again", () => {
    const events: AuditEvent[] = [];
    const store = makeStore({ audit: collect(events) });
    const { planToken } = store.create({ op: "x" }, meta());

    const failed = store.confirmFailed(planToken);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("NOT_EXECUTING");
    }

    const begun = store.beginExecute(planToken, { op: "x" });
    expect(begun.ok).toBe(true);
    const released = store.confirmFailed(planToken);
    expect(released.ok).toBe(true);
    expect(store.listExecuting()).toHaveLength(0);

    const retry = store.beginExecute(planToken, { op: "x" });
    expect(retry.ok).toBe(true);
    store.confirmExecuted(planToken);
    expect(store.listExecuting()).toHaveLength(0);

    expect(events.map((e) => e.status)).toEqual([
      "previewed",
      "failed", // NOT_EXECUTING refusal on the never-begun token
      "executing",
      "failed", // EXECUTION_FAILED release
      "executing",
      "executed",
    ]);
    expect(events[3].detail).toBe("EXECUTION_FAILED");
  });
});

describe("reject during execution", () => {
  it("refuses to reject a plan whose side effect is already in flight", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });
    const result = store.reject(planToken, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ALREADY_EXECUTING");
    }
  });
});

describe("listExecuting", () => {
  it("lists only executing plans, oldest-started first", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      vi.setSystemTime(2_000);
      const later = store.create({ op: "a" }, meta()).planToken;
      vi.setSystemTime(1_000);
      const earlier = store.create({ op: "b" }, meta()).planToken;
      vi.setSystemTime(3_000);
      store.beginExecute(later, { op: "a" });
      vi.setSystemTime(2_000);
      store.beginExecute(earlier, { op: "b" });

      const executing = store.listExecuting();
      expect(executing.map((p) => p.planToken)).toEqual([earlier, later]);
      expect(executing[0].executingSince).toBe(2_000);
      expect(executing[1].executingSince).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an executing plan past its TTL queryable (stuck detection)", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const { planToken } = store.create({ op: "x" }, meta());
      store.beginExecute(planToken, { op: "x" });
      vi.advanceTimersByTime(TTL_MS * 10);
      expect(store.listExecuting()).toHaveLength(1);
      // A sweep must not prune it either.
      store.sweep();
      expect(store.listExecuting()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dataDigest enforcement", () => {
  it("fails closed with DATA_DIGEST_MISMATCH when create() was given a digest", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta("tool", { dataDigest: "digest-v1" }));

    const missing = store.beginExecute(planToken, { op: "x" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("DATA_DIGEST_MISMATCH");
    }

    const wrong = store.beginExecute(planToken, { op: "x" }, "digest-v2");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error.code).toBe("DATA_DIGEST_MISMATCH");
    }

    expect(store.listExecuting()).toHaveLength(0);

    const right = store.beginExecute(planToken, { op: "x" }, "digest-v1");
    expect(right.ok).toBe(true);
  });

  it("is a no-op when create() was not given a digest", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    const result = store.beginExecute(planToken, { op: "x" });
    expect(result.ok).toBe(true);
  });
});

describe("durable journal", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "swmc-crash-"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function journalPath(): string {
    return join(tmpDir, "journal.jsonl");
  }

  it("appends one fsync'd JSON line per state transition", () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken } = store.create({ op: "x" }, meta("t", { reason: "r" }));
    store.beginExecute(planToken, { op: "x" });
    store.confirmExecuted(planToken);

    const lines = readJournal(path);
    expect(lines.map((l) => l.status)).toEqual(["previewed", "executing", "executed"]);
    expect(lines[0]).toMatchObject({ planToken, tool: "t", reason: "r", fingerprint: expect.any(String) });
    expect(lines[1]).toMatchObject({ planToken, status: "executing" });
    expect(lines[2]).toMatchObject({ planToken, status: "executed" });
  });

  it("journals confirmFailed with an EXECUTION_FAILED detail", () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });
    store.confirmFailed(planToken);
    const lines = readJournal(path);
    expect(lines.map((l) => l.status)).toEqual(["previewed", "executing", "failed"]);
    expect(lines[2].detail).toBe("EXECUTION_FAILED");
  });

  it("does not journal gate refusals (they are not transitions)", () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "wrong" }); // PLAN_MISMATCH refusal
    store.beginExecute("deadbeef", { op: "x" }); // UNKNOWN_TOKEN refusal
    expect(readJournal(path)).toHaveLength(1); // only the create line
  });

  it("writes no journal at all when journalPath is omitted (zero config)", () => {
    const store = makeStore();
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });
    store.confirmExecuted(planToken);
    expect(store.listExecuting()).toHaveLength(0);
  });
});

describe("replayJournal", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "swmc-replay-"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function journalPath(): string {
    return join(tmpDir, "journal.jsonl");
  }

  it("reconstructs only the tokens left executing", async () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken: stuck } = store.create({ op: "a" }, meta("t1"));
    const { planToken: done } = store.create({ op: "b" }, meta("t2"));
    store.beginExecute(stuck, { op: "a" });
    store.beginExecute(done, { op: "b" });
    store.confirmExecuted(done);
    store.confirmFailed(stuck);
    store.confirmFailed(stuck); // NOT_EXECUTING refusal, not a transition

    // Re-begin so `stuck` is truly executing at crash time.
    store.beginExecute(stuck, { op: "a" });

    const recovered = await replayJournal<Payload>(path);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].planToken).toBe(stuck);
    expect(recovered[0].fingerprint).toBeDefined();
    expect(recovered[0].meta.tool).toBe("t1");
    expect(recovered[0].payload).toEqual({ op: "a" });
  });

  it("skips a torn final line (crash mid-append) and returns the intact records", async () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });
    // Simulate a crash that tore the last append: append a partial line.
    writeFileSync(path, `\n{"ts":1,"planToken":"${planToken}","status":"execut`, { flag: "a" });
    const recovered = await replayJournal<Payload>(path);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].planToken).toBe(planToken);
  });
});

describe("PlanStore.fromJournal recovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "swmc-recover-"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function journalPath(): string {
    return join(tmpDir, "journal.jsonl");
  }

  it("loads executing tokens with no reconcile and leaves them queryable as stuck", async () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });

    const recovered = await PlanStore.fromJournal<Payload>(path, { planTtlMs: TTL_MS });
    const executing = recovered.listExecuting();
    expect(executing).toHaveLength(1);
    expect(executing[0].planToken).toBe(planToken);
    // No reconcile configured: no guess is made, the token stays executing.
  });

  it("reconcile done -> marks the token executed", async () => {
    const path = journalPath();
    const events: AuditEvent[] = [];
    const store = makeStore({ journalPath: path, audit: collect(events) });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });

    const reconcile = vi.fn(async () => "done" as const);
    const recovered = await PlanStore.fromJournal<Payload>(path, {
      planTtlMs: TTL_MS,
      audit: collect(events),
      reconcile,
    });

    expect(reconcile).toHaveBeenCalledWith(planToken);
    expect(recovered.listExecuting()).toHaveLength(0);
    // A later replay must not re-reconcile a settled token.
    expect(await replayJournal<Payload>(path)).toHaveLength(0);
    expect(events.map((e) => e.status)).toEqual(["previewed", "executing", "executed"]);
  });

  it("reconcile not-done -> allows retry", async () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });

    const recovered = await PlanStore.fromJournal<Payload>(path, {
      planTtlMs: TTL_MS,
      reconcile: async () => "not-done",
    });
    expect(recovered.listExecuting()).toHaveLength(0);

    const retry = recovered.beginExecute(planToken, { op: "x" });
    expect(retry.ok).toBe(true);
    expect(recovered.confirmExecuted(planToken).ok).toBe(true);
  });

  it("reconcile unknown -> leaves the token executing and does not guess", async () => {
    const path = journalPath();
    const events: AuditEvent[] = [];
    const store = makeStore({ journalPath: path, audit: collect(events) });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });

    const recovered = await PlanStore.fromJournal<Payload>(path, {
      planTtlMs: TTL_MS,
      audit: collect(events),
      reconcile: async () => "unknown",
    });
    expect(recovered.listExecuting()).toHaveLength(1);
    // No executed/failed guess was emitted.
    expect(events.map((e) => e.status)).toEqual(["previewed", "executing"]);
  });

  it("a throwing reconcile callback is treated as unknown, never a guess", async () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });

    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const recovered = await PlanStore.fromJournal<Payload>(path, {
        planTtlMs: TTL_MS,
        reconcile: async () => {
          throw new Error("downstream api down");
        },
      });
      expect(recovered.listExecuting()).toHaveLength(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("reconcileStuck settles a single stuck token without restarting", async () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });

    const reconcile = vi.fn()
      .mockResolvedValueOnce("unknown")
      .mockResolvedValueOnce("not-done");
    const recovered = await PlanStore.fromJournal<Payload>(path, {
      planTtlMs: TTL_MS,
      reconcile,
    });
    expect(recovered.listExecuting()).toHaveLength(1);

    const settled = await recovered.reconcileStuck(planToken);
    expect(settled.ok).toBe(true);
    expect(recovered.listExecuting()).toHaveLength(0);
  });

  it("reconcileStuck reports NO_RECONCILE when no callback is configured", async () => {
    const path = journalPath();
    const store = makeStore({ journalPath: path });
    const { planToken } = store.create({ op: "x" }, meta());
    store.beginExecute(planToken, { op: "x" });

    const recovered = await PlanStore.fromJournal<Payload>(path, { planTtlMs: TTL_MS });
    const result = await recovered.reconcileStuck(planToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_RECONCILE");
    }
  });
});

describe("consume() legacy wrapper", () => {
  it("still performs a full execute and emits executing then executed", () => {
    const events: AuditEvent[] = [];
    const store = new PlanStore<Payload>({ planTtlMs: TTL_MS, audit: collect(events) });
    const { planToken } = store.create({ op: "x" }, meta());
    const result = store.consume(planToken, { op: "x" });
    expect(result.ok).toBe(true);
    expect(store.listExecuting()).toHaveLength(0);
    expect(events.map((e) => e.status)).toEqual(["previewed", "executing", "executed"]);

    const second = store.consume(planToken, { op: "x" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBeInstanceOf(PlanError);
      expect(second.error.code).toBe("PLAN_USED");
    }
  });
});