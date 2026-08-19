import { closeSync, createReadStream, fchmodSync, fsyncSync, openSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

import type { PlanMeta } from "./planStore.js";

/**
 * Statuses the journal records per token. These are the *state transitions*
 * the core owns — one line per transition. The audit vocabulary is a superset
 * (it also includes gate-refusal `failed` events and host-owned statuses);
 * refusals never change a token's state, so they are deliberately not
 * journaled.
 */
export type JournalStatus =
  | "previewed"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed";

/**
 * One line of the append-only journal. A full snapshot of the token's state
 * at that transition, so a replay only needs the *latest* record per token to
 * reconstruct it. `payload` is stored best-effort (JSON-serialized form — not
 * necessarily byte-identical to the host's original object) and is only used
 * for rendering recovered stuck-executing plans; the authoritative binding is
 * the stored `fingerprint`.
 */
export interface JournalRecord {
  /** Epoch ms the transition was journaled. */
  ts: number;
  planToken: string;
  status: JournalStatus;
  /** Free-form context for a `failed` transition (e.g. "EXECUTION_FAILED"), else null. */
  detail: string | null;
  tool: string;
  reason: string | null;
  callerId: string;
  previewCount: number | null;
  dataDigest: string | null;
  extra: Readonly<Record<string, unknown>>;
  expiresAt: number;
  requiresApproval: boolean;
  approved: boolean;
  rejected: boolean;
  fingerprint: string;
  payload: unknown;
}

/**
 * A token a restart found mid-execution, reconstructed from the journal. The
 * host reconciles each one with its own `reconcile` callback; the core never
 * guesses whether the side effect actually happened.
 */
export interface RecoveredExecuting<TPayload = unknown> {
  planToken: string;
  /** The payload as it was journaled (JSON-serialized form), best-effort. */
  payload: TPayload;
  /** The fingerprint the payload was bound to at create() — the authoritative check for retries. */
  fingerprint: string;
  meta: PlanMeta;
  expiresAt: number;
  requiresApproval: boolean;
  approved: boolean;
  rejected: boolean;
  /** Epoch ms the executing transition was journaled — when the side effect began. */
  beganAt: number;
}

/**
 * Append-only, fsync'd per-transition journal. Written before the in-memory
 * state change becomes observable, so a crash between the two leaves the
 * journal ahead of the Map — which is exactly the state a restart replays to
 * find tokens that were mid-execute when the process died.
 *
 * The journal is best-effort in the same spirit as the audit sink: a write or
 * fsync failure is reported to stderr and never turns a plan transition into
 * a thrown error. A host that needs a *hard* crash-safety guarantee on a
 * specific transition must treat a stderr journal failure as an alarm.
 *
 * A failed write leaves the descriptor in an unknown position, so the journal
 * is marked unusable after one: subsequent `append()` calls throw instead of
 * silently appending to a corrupt file.
 */
export class AppendOnlyJournal {
  private readonly fd: number;
  private readonly path: string;
  private closed = false;
  private broken = false;

  constructor(path: string) {
    this.path = path;
    // 0o600: the journal holds full plan payloads, so new files must never
    // inherit the process's default (typically group/world-readable) mode.
    this.fd = openSync(path, "a", 0o600);
    try {
      // Tighten an already-existing file to match, best-effort (may be
      // unsupported on some platforms).
      fchmodSync(this.fd, 0o600);
    } catch {
      // Creation already used 0o600; leaving a pre-existing broader mode is
      // the host's responsibility — don't fail the open over it.
    }
  }

  append(record: JournalRecord): void {
    if (this.closed) return;
    if (this.broken) {
      throw new Error(`journal is unusable after a previous write failure (${this.path})`);
    }
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (err) {
      process.stderr.write(`journal: could not serialize record for ${record.planToken}: ${String(err)}\n`);
      return;
    }
    const data = Buffer.from(line + "\n", "utf8");
    try {
      // writeSync is not guaranteed to write the whole buffer in one call —
      // loop until every byte is on the descriptor, then fsync.
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(this.fd, data, offset, data.length - offset);
        if (written <= 0) {
          throw new Error(`writeSync made no progress (${written} bytes); aborting append`);
        }
        offset += written;
      }
      fsyncSync(this.fd);
    } catch (err) {
      // The descriptor position is now unknown — never write to it again.
      this.broken = true;
      process.stderr.write(`journal write failed (${this.path}): ${String(err)}\n`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch {
      // Already closed by the OS; nothing to do.
    }
  }
}

/**
 * Replays a journal file and reconstructs the set of tokens whose *last*
 * recorded transition was `executing` — i.e. the tokens that were mid-side-
 * effect when the process died. Tokens whose latest state is anything else
 * (executed, failed, rejected, expired-then-pruned, ...) are not returned.
 *
 * A torn final line (crash mid-append) is skipped with a stderr note; a
 * journal is only ever appended to, so a truncated line is always the last
 * one and skipping it loses nothing durable.
 */
export async function replayJournal<TPayload = unknown>(
  journalPath: string,
): Promise<RecoveredExecuting<TPayload>[]> {
  const latest = new Map<string, JournalRecord>();
  // Stream line-by-line so an arbitrarily large journal (which may exceed the
  // single-string limit and carry full payloads) is never loaded whole into
  // memory at once.
  const rl = createInterface({ input: createReadStream(journalPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    let rec: JournalRecord;
    try {
      rec = JSON.parse(line) as JournalRecord;
    } catch {
      process.stderr.write(
        `journal: skipping malformed line (torn write?): ${line.slice(0, 120)}\n`,
      );
      continue;
    }
    if (typeof rec.planToken !== "string" || rec.planToken.length === 0) continue;
    latest.set(rec.planToken, rec);
  }

  const out: RecoveredExecuting<TPayload>[] = [];
  for (const [planToken, rec] of latest) {
    if (rec.status !== "executing") continue;
    out.push({
      planToken,
      payload: rec.payload as TPayload,
      fingerprint: rec.fingerprint,
      meta: {
        tool: rec.tool,
        reason: rec.reason,
        callerId: rec.callerId,
        previewCount: rec.previewCount,
        dataDigest: rec.dataDigest,
        extra: rec.extra,
      },
      expiresAt: rec.expiresAt,
      requiresApproval: rec.requiresApproval,
      approved: rec.approved,
      rejected: rec.rejected,
      beganAt: rec.ts,
    });
  }
  return out;
}