import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileJournal,
  NoopJournal,
  PlanStore,
  replayJournal,
} from "../src/index.js";
import type { Journal, JournalEntry, ReconcileResult } from "../src/index.js";
import { PlanError } from "../src/errors.js";

const TTL_MS = 60_000;

describe("NoopJournal", () => {
  it("appends without error and returns empty replay", () => {
    const journal = NoopJournal;
    journal.append({} as JournalEntry);
    expect(journal.replay()).toEqual([]);
    expect(() => journal.close()).not.toThrow();
  });
});

describe("FileJournal", () => {
  const testDir = join(tmpdir(), "safe-write-core-test-" + Date.now());
  const journalPath = join(testDir, "journal.jsonl");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("creates parent directory if missing", () => {
    const nestedDir = join(testDir, "nested", "deep");
    const nestedPath = join(nestedDir, "journal.jsonl");
    const journal = new FileJournal(nestedPath);
    expect(existsSync(nestedDir)).toBe(true);
    journal.append({
      version: 1,
      ts: Date.now(),
      token: "abc",
      status: "previewed",
      expiresAt: Date.now() + TTL_MS,
      fingerprint: "fp",
      meta: { tool: "t", reason: null, callerId: "c", previewCount: null, dataDigest: null, extra: {} },
      flags: { requiresApproval: false, approved: true, rejected: false, rejectionReason: null, used: false, executing: false },
    } as JournalEntry);
    journal.close();
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("writes entries that can be replayed", () => {
    const journal = new FileJournal(journalPath);
    const entry1 = {
      version: 1 as const,
      ts: Date.now(),
      token: "token1",
      status: "previewed" as const,
      expiresAt: Date.now() + TTL_MS,
      fingerprint: "fp1",
      meta: { tool: "t1", reason: null, callerId: "c", previewCount: null, dataDigest: null, extra: {} },
      flags: { requiresApproval: false, approved: true, rejected: false, rejectionReason: null, used: false, executing: false },
    };
    const entry2 = { ...entry1, token: "token2", status: "awaiting_approval" as const, flags: { ...entry1.flags, requiresApproval: true, approved: false } };
    journal.append(entry1 as JournalEntry);
    journal.append(entry2 as JournalEntry);
    journal.close();

    const journal2 = new FileJournal(journalPath);
    const entries = journal2.replay();
    expect(entries).toHaveLength(2);
    expect(entries[0].token).toBe("token1");
    expect(entries[1].token).toBe("token2");
    journal2.close();
  });

  it("skips malformed lines on replay (crash resilience)", () => {
    const journal = new FileJournal(journalPath);
    const goodEntry = {
      version: 1 as const,
      ts: Date.now(),
      token: "good",
      status: "previewed" as const,
      expiresAt: Date.now() + TTL_MS,
      fingerprint: "fp",
      meta: { tool: "t", reason: null, callerId: "c", previewCount: null, dataDigest: null, extra: {} },
      flags: { requiresApproval: false, approved: true, rejected: false, rejectionReason: null, used: false, executing: false },
    };
    journal.append(goodEntry as JournalEntry);
    journal.close();

    // Append a partial write (simulating crash mid-line)
    const raw = readFileSync(journalPath, "utf-8");
    writeFileSync(journalPath, raw + '{"version":1,"token":"partial", "status": "previewed"');  // malformed JSON

    const journal2 = new FileJournal(journalPath);
    const entries = journal2.replay();
    expect(entries).toHaveLength(1);
    expect(entries[0].token).toBe("good");
    journal2.close();
  });

  it("returns empty replay for missing file", () => {
    const journal = new FileJournal(join(testDir, "nonexistent.jsonl"));
    expect(journal.replay()).toEqual([]);
    journal.close();
  });

  it("returns empty replay for empty file", () => {
    writeFileSync(journalPath, "");
    const journal = new FileJournal(journalPath);
    expect(journal.replay()).toEqual([]);
    journal.close();
  });
});

describe("replayJournal", () => {
  const now = Date.now();

  it("keeps non-expired, non-used entries", () => {
    const entries: JournalEntry[] = [
      {
        version: 1,
        ts: now,
        token: "live",
        status: "previewed",
        expiresAt: now + TTL_MS,
        fingerprint: "fp",
        meta: { tool: "t", reason: null, callerId: "c", previewCount: null, dataDigest: null, extra: {} },
        flags: { requiresApproval: false, approved: true, rejected: false, rejectionReason: null, used: false, executing: false },
      },
    ];
    const map = replayJournal(entries);
    expect(map.has("live")).toBe(true);
  });

  it("drops expired entries", () => {
    const entries: JournalEntry[] = [
      {
        version: 1,
        ts: now,
        token: "expired",
        status: "previewed",
        expiresAt: now - 1000,
        fingerprint: "fp",
        meta: { tool: "t", reason: null, callerId: "c", previewCount: null, dataDigest: null, extra: {} },
        flags: { requiresApproval: false, approved: true, rejected: false, rejectionReason: null, used: false, executing: false },
      },
    ];
    expect(replayJournal(entries).has("expired")).toBe(false);
  });

  it("drops used entries", () => {
    const entries: JournalEntry[] = [
      {
        version: 1,
        ts: now,
        token: "used",
        status: "executed",
        expiresAt: now + TTL_MS,
        fingerprint: "fp",
        meta: { tool: "t", reason: null, callerId: "c", previewCount: null, dataDigest: null, extra: {} },
        flags: { requiresApproval: false, approved: true, rejected: false, rejectionReason: null, used: true, executing: false },
      },
    ];
    expect(replayJournal(entries).has("used")).toBe(false);
  });

  it("keeps rejected tombstones even when expired", () => {
    const entries: JournalEntry[] = [
      {
        version: 1,
        ts: now,
        token: "rejected",
        status: "rejected",
        expiresAt: now - 1000,
        fingerprint: "fp",
        meta: { tool: "t", reason: null, callerId: "c", previewCount: null, dataDigest: null, extra: {} },
        flags: { requiresApproval: true, approved: false, rejected: true, rejectionReason: "too broad", used: false, executing: false },
      },
    ];
    expect(replayJournal(entries).has("rejected")).toBe(true);
  });

  it("keeps executing entries (crash recovery)", () => {
    const entries: JournalEntry[] = [
      {
        version: 1,
        ts: now,
        token: "stuck",
        status: "executing",
        expiresAt: now + TTL_MS,
        fingerprint: "fp",
        meta: { tool: "t", reason: null, callerId: "c", previewCount: null, dataDigest: null, extra: {} },
        flags: { requiresApproval: false, approved: true, rejected: false, rejectionReason: null, used: false, executing: true },
      },
    ];
    expect(replayJournal(entries).has("stuck")).toBe(true);
  });
});

describe("PlanStore v0.2: beginExecute / confirmExecuted / confirmFailed", () => {
  it("beginExecute transitions to 'executing' and returns token + meta", () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    const result = store.beginExecute(planToken, { op: "send" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.planToken).toBe(planToken);
      expect(result.meta.tool).toBe("esign_send");
    }
  });

  it("beginExecute sets the executing flag in the journal", () => {
    const appended: JournalEntry[] = [];
    const trackingJournal: Journal = {
      append: (e) => appended.push(e),
      replay: () => [],
      close: () => {},
    };
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, journal: trackingJournal });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    store.beginExecute(planToken, { op: "send" });
    const executingEntries = appended.filter((e) => e.status === "executing");
    expect(executingEntries).toHaveLength(1);
    expect(executingEntries[0].token).toBe(planToken);
    expect(executingEntries[0].flags.executing).toBe(true);
  });

  it("confirmExecuted marks the plan used and audits 'executed'", async () => {
    const events: Array<{ status: string }> = [];
    const collectEvents = {
      record: (e: { status: string }) => {
        events.push({ status: e.status });
        return undefined;
      },
    };
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, audit: collectEvents });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    store.beginExecute(planToken, { op: "send" });
    const result = await store.confirmExecuted(planToken);
    expect(result.ok).toBe(true);

    // consume should now report PLAN_USED
    const consumed = store.consume(planToken, { op: "send" });
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) {
      expect(consumed.error.code).toBe("PLAN_USED");
    }

    // Audit events should include executing and executed
    const statuses = events.map((e) => e.status);
    expect(statuses).toContain("executing");
    expect(statuses).toContain("executed");
  });

  it("confirmFailed clears executing without marking used", () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    store.beginExecute(planToken, { op: "send" });
    const result = store.confirmFailed(planToken, "API timeout");
    expect(result.ok).toBe(true);

    // Plan should still be consumable (retry)
    const consumed = store.consume(planToken, { op: "send" });
    expect(consumed.ok).toBe(true);
  });

  it("beginExecute on a gated plan requires approval first", () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send", approvalRequired: true });
    const result = store.beginExecute(planToken, { op: "send" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AWAITING_APPROVAL");
    }
  });

  it("beginExecute on an already-executing plan returns PLAN_EXECUTING", () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    store.beginExecute(planToken, { op: "send" });
    const second = store.beginExecute(planToken, { op: "send" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("PLAN_EXECUTING");
    }
  });

  it("confirmExecuted without beginExecute returns PLAN_NOT_EXECUTING", async () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    const result = await store.confirmExecuted(planToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_NOT_EXECUTING");
    }
  });

  it("confirmFailed without beginExecute returns PLAN_NOT_EXECUTING", () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    const result = store.confirmFailed(planToken, "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_NOT_EXECUTING");
    }
  });

  it("beginExecute with wrong fingerprint returns PLAN_MISMATCH", () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    const result = store.beginExecute(planToken, { op: "different" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_MISMATCH");
    }
  });
});

describe("PlanStore v0.2: listExecuting", () => {
  it("returns plans stuck in 'executing' state", () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken: token1 } = store.create({ op: "a" }, { tool: "t1" });
    const { planToken: token2 } = store.create({ op: "b" }, { tool: "t2" });
    store.create({ op: "c" }, { tool: "t3" }); // not executing
    store.beginExecute(token1, { op: "a" });
    store.beginExecute(token2, { op: "b" });
    const executing = store.listExecuting();
    expect(executing).toHaveLength(2);
    const tokens = executing.map((e) => e.planToken);
    expect(tokens).toContain(token1);
    expect(tokens).toContain(token2);
  });

  it("excludes plans after confirmExecuted", async () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "a" }, { tool: "t1" });
    store.beginExecute(planToken, { op: "a" });
    expect(store.listExecuting()).toHaveLength(1);
    await store.confirmExecuted(planToken);
    expect(store.listExecuting()).toHaveLength(0);
  });

  it("excludes plans after confirmFailed", () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "a" }, { tool: "t1" });
    store.beginExecute(planToken, { op: "a" });
    expect(store.listExecuting()).toHaveLength(1);
    store.confirmFailed(planToken, "API timeout");
    expect(store.listExecuting()).toHaveLength(0);
  });

  it("returns empty array when no plans are executing", () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    store.create({ op: "a" }, { tool: "t1" });
    expect(store.listExecuting()).toHaveLength(0);
  });
});

describe("PlanStore v0.2: reconcile callback", () => {
  it("calls reconcile after confirmExecuted and marks executed on 'done'", async () => {
    const calls: string[] = [];
    const reconcile: (token: string) => Promise<ReconcileResult> = async (token) => {
      calls.push(token);
      return "done";
    };
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, reconcile });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    store.beginExecute(planToken, { op: "send" });
    const result = await store.confirmExecuted(planToken);
    expect(result.ok).toBe(true);
    expect(calls).toContain(planToken);
  });

  it("on 'unknown' reconcile, plan stays executing", async () => {
    const reconcile = async (): Promise<ReconcileResult> => "unknown";
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, reconcile });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    store.beginExecute(planToken, { op: "send" });
    const result = await store.confirmExecuted(planToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RECONCILE_UNKNOWN");
    }
    // Plan should still be in executing
    expect(store.listExecuting()).toHaveLength(1);
  });

  it("on 'not-done' reconcile, plan is marked failed and not used", async () => {
    const reconcile = async (): Promise<ReconcileResult> => "not-done";
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, reconcile });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    store.beginExecute(planToken, { op: "send" });
    const result = await store.confirmExecuted(planToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RECONCILE_NOT_DONE");
    }
    // Plan should not be used — can be retried
    expect(store.listExecuting()).toHaveLength(0);
    const consumed = store.consume(planToken, { op: "send" });
    expect(consumed.ok).toBe(true);
  });

  it("without reconcile callback, confirmExecuted marks executed directly", async () => {
    const store = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS });
    const { planToken } = store.create({ op: "send" }, { tool: "esign_send" });
    store.beginExecute(planToken, { op: "send" });
    const result = await store.confirmExecuted(planToken);
    expect(result.ok).toBe(true);
    const consumed = store.consume(planToken, { op: "send" });
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) {
      expect(consumed.error.code).toBe("PLAN_USED");
    }
  });
});

describe("PlanStore v0.2: crash recovery via journal", () => {
  const testDir = join(tmpdir(), "safe-write-crash-test-" + Date.now());
  const journalPath = join(testDir, "crash-journal.jsonl");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("restores 'executing' plans on startup (crash during beginExecute)", () => {
    // Step 1: Create store with journal, create plan, beginExecute
    const journal1 = new FileJournal(journalPath);
    const store1 = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, journal: journal1 });
    const { planToken } = store1.create({ op: "send" }, { tool: "esign_send" });
    store1.beginExecute(planToken, { op: "send" });
    journal1.close();

    // Step 2: Simulate crash — create a new store from the same journal
    const journal2 = new FileJournal(journalPath);
    const store2 = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, journal: journal2 });

    // Step 3: The plan should be in listExecuting
    const executing = store2.listExecuting();
    expect(executing).toHaveLength(1);
    expect(executing[0].planToken).toBe(planToken);

    // Step 4: Host can reconcile and confirm
    const result = store2.confirmFailed(planToken, "crash recovery");
    expect(result.ok).toBe(true);
    expect(store2.listExecuting()).toHaveLength(0);

    journal2.close();
  });

  it("restores approved plans on startup", () => {
    const journal1 = new FileJournal(journalPath);
    const store1 = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, journal: journal1 });
    const { planToken } = store1.create({ op: "send" }, { tool: "esign_send", approvalRequired: true });
    store1.approve(planToken);
    journal1.close();

    const journal2 = new FileJournal(journalPath);
    const store2 = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, journal: journal2 });
    const consumed = store2.consume(planToken, { op: "send" });
    expect(consumed.ok).toBe(true);
    journal2.close();
  });

  it("restores rejected tombstones on startup", () => {
    const journal1 = new FileJournal(journalPath);
    const store1 = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, journal: journal1 });
    const { planToken } = store1.create({ op: "send" }, { tool: "esign_send", approvalRequired: true });
    store1.reject(planToken, "too broad");
    journal1.close();

    const journal2 = new FileJournal(journalPath);
    const store2 = new PlanStore<{ op: string }>({ planTtlMs: TTL_MS, journal: journal2 });
    const consumed = store2.consume(planToken, { op: "send" });
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) {
      expect(consumed.error.code).toBe("PLAN_REJECTED");
      expect(consumed.error.message).toContain("too broad");
    }
    journal2.close();
  });
});
