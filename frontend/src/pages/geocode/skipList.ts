/* Work-queue batches skipped from the Geocode page, remembered in this browser
 * (Home reads the same key to count and clear them). Separate from the
 * passed-over set: Skip says "not this one, ever", Next "not this one, now". */

export const SKIPPED_BATCHES_KEY = "geotagger.workqueue.skipped";

export function loadSkipped(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SKIPPED_BATCHES_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveSkipped(ids: readonly string[]): void {
  try {
    localStorage.setItem(SKIPPED_BATCHES_KEY, JSON.stringify(ids));
  } catch {
    // A full/blocked localStorage costs the skip list, not the tagging pass.
  }
}

/** Add `id` to the stored skip list (once). */
export function addSkipped(id: string): string[] {
  const list = loadSkipped();
  if (!list.includes(id)) list.push(id);
  saveSkipped(list);
  return list;
}

/** The /api/work-queue/next `skip` value: skipped ∪ passed over, de-duplicated. */
export function skipParam(skipped: readonly string[], passedOver: Iterable<string>): string {
  return [...new Set([...skipped, ...passedOver])].join(",");
}

/** How many of a batch's members still need a decision. Staged-but-uncommitted
 *  ones count as done — the user has made the call, Commit just writes it. A
 *  member not loaded counts as done too: there is nothing on screen to decide. */
export function batchRemaining(photoIds: readonly number[], photos: readonly { id: number; lat?: number | null; geocode_ignored?: boolean }[],
  isStaged: (id: number) => boolean): number {
  const byId = new Map(photos.map((p) => [p.id, p]));
  return photoIds.filter((id) => {
    if (isStaged(id)) return false;
    const p = byId.get(id);
    return p ? p.lat == null && !p.geocode_ignored : false;
  }).length;
}
