/* ── Staged work that survives a reload (U7) ──
 * Port of common.js stagedWorkStore, shared by the pages that stage edits in
 * memory until Commit / Save (Geocode, Time Sync). Each mirrors its staged set
 * into sessionStorage on every change and offers it back on the next load.
 *
 * Why sessionStorage, not localStorage: it is per tab, so two tabs of one page
 * never overwrite each other's staging area, yet it survives a reload, a tab
 * reopened with Ctrl+Shift+T and the browser's restore-after-crash. It can't
 * survive opening the app fresh in a new tab once the old one is gone; each
 * page's beforeunload prompt still covers that.
 *
 * Only ids plus the intended values are stored, never whole server objects: on
 * load the page re-fetches those ids and drops anything deleted or already
 * applied, so a restore never commits by itself.
 *
 * The schema version is in the key (and the value): bumping it orphans old
 * records rather than misreading them, and load() sweeps other versions of the
 * same page's key. Keys are the legacy pages' (geotagger.staged.<page>.v<n>), so
 * work staged on a legacy page carries over. Every storage call is wrapped:
 * blocked or full storage just means the backup is skipped (save() returns
 * false), never that staging stops working. */

export const STAGED_PREFIX = "geotagger.staged.";

export const STAGED_SAVE_FAILED_MSG =
  "Couldn't back up the staged changes in this tab (browser storage is full or blocked). " +
  "They're still staged, but a reload or crash before you commit will lose them.";

export type StagedWorkStore<R extends { id: number }> = {
  key: string;
  /** The saved records (integer ids only), or []. */
  load: () => R[];
  /** Replace the saved set; an empty list removes the key. False on failure. */
  save: (records: R[]) => boolean;
  clear: () => void;
};

export function stagedWorkStore<R extends { id: number }>(page: string, version: number): StagedWorkStore<R> {
  const key = `${STAGED_PREFIX}${page}.v${version}`;
  return {
    key,
    load() {
      try {
        // Sweep records an older (or newer) build of this page wrote.
        const stem = `${STAGED_PREFIX}${page}.v`;
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith(stem) && k !== key) sessionStorage.removeItem(k);
        }
        const raw = sessionStorage.getItem(key);
        if (!raw) return [];
        const data = JSON.parse(raw) as { v?: unknown; entries?: unknown };
        if (!data || data.v !== version || !Array.isArray(data.entries)) return [];
        return (data.entries as R[]).filter((r) => r && Number.isInteger(r.id));
      } catch {
        return [];
      }
    },
    save(records) {
      try {
        if (!records.length) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify({ v: version, savedAt: Date.now(), entries: records }));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      try { sessionStorage.removeItem(key); } catch { /* storage blocked */ }
    },
  };
}
