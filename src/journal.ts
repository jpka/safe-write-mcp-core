import { closeSync, existsSync, openSync, readFileSync, fsyncSync, mkdirSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import type { AuditStatus } from "./audit.js";
import type { PlanMeta } from "./planStore.js";

/**
 * The lifecycle statuses the core records in the journal. Subset of
 * AuditStatus — only the transitions the core itself emits.
 */
export type JournalStatus =
  | "previewed"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "executed"
  | "rejected"
  | "failed";

/**
 * One immutable journal line. Every appends records a single plan transition;
 * replaying all lines rebuilds the in-memory state on restart.
 */
export interface JournalEntry {
  /** Schema version for forward compatibility. */
  version: 1;
  /** Epoch milliseconds when the entry was appended. */
  ts: number;
  /** The plan token this entry describes. */
  token: string;
  /** The lifecycle status after this transition. */
  status: JournalStatus;
  /** Plan expiry in epoch milliseconds — replay enforces TTL on restore. */
  expiresAt: number;
  /** sha256 fingerprint of the payload at create time. */
  fingerprint: string;
  /** The PlanMeta as recorded at create time. */
  meta: {
    tool: string;
    reason: string | null;
    callerId: string;
    previewCount: number | null;
    dataDigest: string | null;
    extra: Readonly<Record<string, unknown>>;
  };
  /** Boolean flags restored on replay. */
  flags: {
    requiresApproval: boolean;
    approved: boolean;
    rejected: boolean;
    rejectionReason: string | null;
    used: boolean;
    executing: boolean;
  };
}

/**
 * A host-supplied journal. The core appends one line per transition; on
 * startup the host replays the journal to restore state. The journal is the
 * crash-safety mechanism — without it, an `executing` plan is silently
 * forgotten on restart.
 */
export interface Journal {
  /** Append one entry. Must fsync before returning. */
  append(entry: JournalEntry): void;
  /** Read all entries in order. Called once on startup. */
  replay(): JournalEntry[];
  /** Release any underlying file handle. */
  close(): void;
}

/** Default: no persistence. Used when the host does not configure a journal. */
export const NoopJournal: Journal = {
  append(): void {},
  replay(): JournalEntry[] {
    return [];
  },
  close(): void {},
};

/**
 * Append-only JSONL journal with fsync per line. Each entry is one JSON object
 * terminated by a newline; partial writes from a crash mid-line are skipped on
 * replay (the line won't parse).
 */
export class FileJournal implements Journal {
  private fd: number | null;

  constructor(private path: string) {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.fd = openSync(path, "a");
  }

  append(entry: JournalEntry): void {
    if (this.fd === null) return;
    const line = JSON.stringify(entry) + "\n";
    writeSync(this.fd, line);
    fsyncSync(this.fd);
  }

  replay(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    const content = readFileSync(this.path, "utf-8");
    if (!content.trim()) return [];
    const entries: JournalEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (entry.version === 1) {
          entries.push(entry);
        }
      } catch {
        // Malformed line (crash mid-write) — skip it.
      }
    }
    return entries;
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

/**
 * Builds a JournalEntry from the current state of a TokenEntry. Called on
 * every state transition that the journal must record.
 */
export function makeJournalEntry(
  token: string,
  status: JournalStatus,
  expiresAt: number,
  fingerprint: string,
  meta: PlanMeta,
  flags: {
    requiresApproval: boolean;
    approved: boolean;
    rejected: boolean;
    rejectionReason: string | null;
    used: boolean;
    executing: boolean;
  },
): JournalEntry {
  return {
    version: 1,
    ts: Date.now(),
    token,
    status,
    expiresAt,
    fingerprint,
    meta: {
      tool: meta.tool,
      reason: meta.reason,
      callerId: meta.callerId,
      previewCount: meta.previewCount,
      dataDigest: meta.dataDigest,
      extra: { ...meta.extra },
    },
    flags: { ...flags },
  };
}
