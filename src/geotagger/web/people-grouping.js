/* people-grouping.js — People page: grouping/sorting of face lists (month,
 * location, person, photo, directory, ignore/come-back/tag batches, events).
 * No DOM work; reads/writes only shared state from people-state.js. */

/* ── Month grouping (unlabeled queue) ── */
function computeMonthGroups(list) {
  // `list` is chronological with undated faces first (see loadFaces).
  const groups = [];
  let cur = null;
  list.forEach(f => {
    let year = null, month = null;
    if (f.photo_datetime) {
      const d = new Date(f.photo_datetime * 1000);
      year = d.getFullYear();
      month = d.getMonth();
    }
    if (!cur || cur.year !== year || cur.month !== month) {
      cur = { year, month, faces: [] };
      groups.push(cur);
    }
    cur.faces.push(f);
  });
  return groups;
}

// Month → location grouping. Within each chronological month, faces are bucketed
// by resolved location; buckets keep first-seen order, which (because `list` is
// chronological) is the order each location first appears that month. Faces with
// no location collect into one "No location" bucket per month — except in the
// Undated month (no timestamp to group by either), where a lone "No location"
// bucket would dump every stranger photo in the library into one pile, so it's
// split further by containing directory (folder is often the only surviving
// hint of what a scanned/undated batch is). Each bucket's faces are then
// clustered by suggested person (see sortBucketBySuggestion) so the same person
// is contiguous — this is what makes `unlabeledAll` (the flat selection list)
// and the render agree, so the ordering must live here, in the shared choke point.
function computeMonthLocationGroups(list) {
  const out = [];
  computeMonthGroups(list).forEach(mg => {
    const undated = mg.year === null;
    const buckets = new Map();   // bucket key → group
    mg.faces.forEach(f => {
      const loc = locationKey(f);
      const dir = !loc && undated ? dirLabel(f) : null;
      const key = loc ? `loc:${loc}` : (dir ? `dir:${dir}` : "");
      let b = buckets.get(key);
      if (!b) {
        b = { year: mg.year, month: mg.month, place: loc || null, dir, faces: [] };
        buckets.set(key, b);
      }
      b.faces.push(f);
    });
    buckets.forEach((b, key) => {
      b.faces = sortBucketBySuggestion(b.faces, `ml:${mg.year}-${mg.month}:${key}`);
    });
    out.push(...buckets.values());
  });
  return out;
}

// Person-first hierarchy for the Unlabeled queue: suggested person (or "No
// suggestion") → date-range chunks within that person, chunks sorted
// chronologically inside. Mirrors computeMonthLocationGroups's nesting, just
// with the two outer levels swapped.
const UNLABELED_PERSON_GAP_SECONDS = 86400;   // new date-range chunk after this big a gap

function computeUnlabeledPersonGroups(list) {
  const buckets = new Map();   // person_id ("none" for unsuggested) → { name, faces }
  list.forEach(f => {
    const pid = f.suggestion ? f.suggestion.person_id : "none";
    let b = buckets.get(pid);
    if (!b) {
      b = { personId: pid, name: f.suggestion ? f.suggestion.person_name : null, faces: [] };
      buckets.set(pid, b);
    }
    b.faces.push(f);
  });
  const named = [...buckets.values()].filter(b => b.personId !== "none")
    .sort((a, b) => a.name.localeCompare(b.name));
  const none = buckets.get("none");
  const personGroups = none ? [...named, none] : named;
  personGroups.forEach(b => { b.chunks = computeTimeGroups(b.faces, UNLABELED_PERSON_GAP_SECONDS); });
  return personGroups;
}

// Photo hierarchy for the Unlabeled queue: one group per source photo, so a
// photo's unlabeled faces are reviewed (and ignored/accepted) together. Faces
// keep the shared bucket ordering within a photo (suggested people contiguous),
// and each group carries year/month so the date sort can still draw dividers.
function computeUnlabeledPhotoGroups(list) {
  const buckets = new Map();   // photo_id → group
  list.forEach(f => {
    let b = buckets.get(f.photo_id);
    if (!b) {
      const ts = f.photo_datetime;
      const d = ts ? new Date(ts * 1000) : null;
      b = {
        photoId: f.photo_id,
        filename: f.filename || dirLabel(f),
        year: d ? d.getFullYear() : null,
        month: d ? d.getMonth() : null,
        faces: [],
      };
      buckets.set(f.photo_id, b);
    }
    b.faces.push(f);
  });
  buckets.forEach(b => {
    b.faces = sortBucketBySuggestion(b.faces, `photo:${b.photoId}`);
  });
  return [...buckets.values()];
}

// Directory hierarchy for the Unlabeled queue: one group per containing folder,
// keyed on the photo's full `dir` so sibling folders that share a leaf name
// (…/1985/Scans and …/1990/Scans) stay apart. This is the axis that works for
// scanned photos — no timestamp, no GPS, so the month→location grid piles them
// all into one "Undated / No location" heap, while the folder is usually the
// only surviving hint of what the batch is. Groups come out alphabetical by
// path; sortGroups is stable, so folders that tie on the active sort key (every
// one of them, when undated) keep that A→Z order.
function computeUnlabeledDirGroups(list) {
  const buckets = new Map();   // full dir path ("" when unknown) → group
  list.forEach(f => {
    const key = f.dir || "";
    let b = buckets.get(key);
    if (!b) {
      b = { dir: f.dir || null, name: dirLabel(f), faces: [] };
      buckets.set(key, b);
    }
    b.faces.push(f);
  });
  const groups = [...buckets.values()]
    .sort((a, b) => (a.dir || "").localeCompare(b.dir || ""));
  groups.forEach(g => { g.faces = sortBucketBySuggestion(g.faces, `dir:${g.dir}`); });
  return groups;
}

// "…/Scans/1985 Box" — the last two segments of a full path. Enough to tell
// sibling folders apart in a header without spilling an absolute path across it.
function shortDirPath(dir) {
  if (!dir) return "Unknown folder";
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return "…/" + parts.slice(-2).join("/");
}

// Order the faces within one location bucket so the same suggested person is
// adjacent (so you can rubber-band / confirm a person's faces as a run): guessed
// faces first, grouped by suggested person and ordered by that person's earliest
// photo in the bucket (chronological first-appearance), each person's faces in
// time order; faces with no suggestion ("unknown") sink to the bottom. The sort is
// a fixed point — re-running it on already-sorted faces is a no-op — because the
// per-person earliest timestamp is order-independent, so the flat list and the
// re-grouped render stay in sync.
// `cacheKey` identifies the bucket across renders: the per-person rank is frozen
// on first sight (see runOrderRank) so removing faces mid-pass can't reshuffle
// the runs. Omit it for one-off/unstable buckets.
function sortBucketBySuggestion(faceList, cacheKey) {
  const firstTs = new Map();   // person_id → earliest photo_datetime in this bucket
  faceList.forEach(f => {
    const pid = f.suggestion ? f.suggestion.person_id : null;
    if (pid == null) return;
    const ts = f.photo_datetime || 0;
    if (!firstTs.has(pid) || ts < firstTs.get(pid)) firstTs.set(pid, ts);
  });
  if (cacheKey) {
    firstTs.forEach((ts, pid) => {
      const k = `${cacheKey}|${pid}`;
      // Person seen here before → reuse their frozen rank; otherwise freeze now.
      if (runOrderRank.has(k)) firstTs.set(pid, runOrderRank.get(k));
      else runOrderRank.set(k, ts);
    });
  }
  return faceList.slice().sort((a, b) => {
    const pa = a.suggestion ? a.suggestion.person_id : null;
    const pb = b.suggestion ? b.suggestion.person_id : null;
    if ((pa == null) !== (pb == null)) return pa == null ? 1 : -1;  // unknowns last
    if (pa !== pb) {
      const fa = firstTs.get(pa), fb = firstTs.get(pb);
      if (fa !== fb) return fa - fb;   // person blocks in first-appearance order
      return pa - pb;                  // same earliest ts: stable tiebreak by id
    }
    return (a.photo_datetime || 0) - (b.photo_datetime || 0);  // within a block: chronological
  });
}

// "Mar 3 – Mar 8" date span across a group's faces (undated faces ignored).
function facesDateRange(faceList) {
  const ts = faceList.map(f => f.photo_datetime).filter(Boolean);
  if (!ts.length) return "Undated";
  return formatDateRange(Math.min(...ts), Math.max(...ts));
}

/* ── Ignore-batch grouping (ignored view) ── */
function computeIgnoreBatches(list) {
  // `list` is newest-first by ignored_at; faces ignored together share a value.
  // Faces with no ignored_at (ignored before this column existed) go in one trailing group.
  const groups = [];
  let cur = null;
  list.forEach(f => {
    const key = f.ignored_at ?? null;
    if (!cur || cur.ts !== key) { cur = { ts: key, faces: [] }; groups.push(cur); }
    cur.faces.push(f);
  });
  return groups;
}

/* ── Come-back-batch grouping (Come Back view) ── */
function computeComeBackBatches(list) {
  // `list` is newest-first by come_back_at; faces deferred together share a value.
  const groups = [];
  let cur = null;
  list.forEach(f => {
    const key = f.come_back_at ?? null;
    if (!cur || cur.ts !== key) { cur = { ts: key, faces: [] }; groups.push(cur); }
    cur.faces.push(f);
  });
  return groups;
}

/* ── Tag-batch grouping (recently tagged view) ── */
function computeTagBatches(list) {
  // `list` is newest-first by assigned_at; faces tagged together share a value.
  const groups = [];
  let cur = null;
  list.forEach(f => {
    if (!cur || cur.ts !== f.assigned_at) { cur = { ts: f.assigned_at, faces: [] }; groups.push(cur); }
    cur.faces.push(f);
  });
  return groups;
}

function formatRelativeTime(ts) {
  if (!ts) return "unknown time";
  const sec = Date.now() / 1000 - ts;
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  if (sec < 7 * 86400) return `${Math.round(sec / 86400)} days ago`;
  return new Date(ts * 1000).toLocaleString();
}

/* ── Event grouping (guesses view) ── */
function computeTimeGroups(list, gapSeconds) {
  // `list` is already chronological with undated faces last (see loadFaces).
  const groups = [];
  let cur = null;
  list.forEach(f => {
    const ts = f.photo_datetime;
    if (!ts) {                                  // collect undated (0/null; negative = pre-1970) into one trailing group
      if (!cur || !cur.undated) { cur = { faces: [], undated: true }; groups.push(cur); }
      cur.faces.push(f);
      return;
    }
    if (!cur || cur.undated || ts - cur.end > gapSeconds) {
      cur = { faces: [], start: ts, end: ts, undated: false };
      groups.push(cur);
    }
    cur.faces.push(f);
    cur.end = ts;
  });
  return groups;
}

function formatGroupRange(group) {
  return group.undated ? "Undated" : formatDateRange(group.start, group.end);
}
