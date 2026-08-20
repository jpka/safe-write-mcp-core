import type { JournalEntry } from "./journal.js";

/**
 * Replay a journal to reconstruct the set of non-expired, non-swept entries.
 * Used on startup to detect plans stuck in "executing" after a crash.
 *
 * Returns a map of token → entry for entries that are still "alive" after
 * replay — i.e. not expired, not used, not rejected. An entry stuck in
 * "executing" is included so the host can query it.
 */
export function replayJournal(entries: JournalEntry[]): Map<string, JournalEntry> {
  const now = Date.now();
  const map = new Map<string, JournalEntry>();
  for (const entry of entries) {
    // Rejected tombstones: keep first (same as sweep — they never expire)
    if (entry.flags.rejected) {
      map.set(entry.token, entry);
      continue;
    }
    // Expired entries: skip
    if (now > entry.expiresAt) {
      map.delete(entry.token);
      continue;
    }
    // Used entries: skip
    if (entry.flags.used) {
      map.delete(entry.token);
      continue;
    }
    map.set(entry.token, entry);
  }
  return map;
}
