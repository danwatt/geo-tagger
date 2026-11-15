import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../api/client";
import { plural } from "../../lib/format";
import { SegmentedToggle, Spinner } from "../../ui/ui";

/* "33,109 remaining" is not a task; a batch is. Read-only list: every row opens
 * Geocode with that batch loaded. One query per kind (TanStack Query keys), so
 * switching tabs mid-load can't mix the old kind's rows into the new list. */

const PAGE = 20;
// The list Geocode's Skip button writes (same key as common.js). It lives in this
// browser's localStorage, so Home is the only place that can offer to clear it.
const SKIPPED_BATCHES_KEY = "geotagger.workqueue.skipped";

type Kind = "all" | "session" | "folder";
type Batch = Schemas["Batch"];

/** Green when nearly every member has a time-neighbour vote, amber at a coin
 *  flip: tells the user whether to expect one click or a map drag. */
export function confClass(confidence: number): string {
  if (confidence >= 0.8) return "wq-conf good";
  if (confidence >= 0.4) return "wq-conf fair";
  return "wq-conf weak";
}

function skippedCount(): number {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SKIPPED_BATCHES_KEY) || "[]");
    return Array.isArray(raw) ? raw.length : 0;
  } catch {
    return 0;
  }
}

function BatchRow({ b }: { b: Batch }) {
  return (
    <li className="wq-row">
      <div className="wq-thumbs">
        {b.sample_photo_ids.map((id) => <img key={id} src={`/api/thumbnail/${id}`} loading="lazy" alt="" />)}
      </div>
      <div className="wq-body">
        <div className="wq-row-title">{b.title}</div>
        <div className="wq-row-meta">
          {/* A batch with votes promises a place; folders and undated runs say
              so plainly rather than pretending the map step isn't coming. */}
          {b.proposal ? (
            <>
              📍 {b.proposal.label}
              <span className={confClass(b.confidence)}>● {Math.round(b.confidence * 100)}% have a guess</span>
            </>
          ) : (
            <span className="wq-noguess">{b.start_ts ? "no guess" : "no date · no guess"}</span>
          )}
        </div>
      </div>
      <div className="wq-count">{plural(b.count, "photo")}</div>
      <a className="button primary" href={`/geocode.html?batch=${encodeURIComponent(b.id)}`}>Open in Geocode</a>
    </li>
  );
}

export function WorkQueue() {
  const [kind, setKind] = useState<Kind>("all");
  const [skipped, setSkipped] = useState(skippedCount);

  const q = useInfiniteQuery({
    queryKey: ["work-queue", kind],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(await api.GET("/api/work-queue", { params: { query: { limit: PAGE, offset: pageParam, kind } }, signal })),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.batches.length, 0);
      return loaded < last.total_batches && last.batches.length ? loaded : undefined;
    },
  });

  const pages = q.data?.pages ?? [];
  const batches = pages.flatMap((p) => p.batches);
  const head = pages[pages.length - 1];
  const left = head ? head.total_batches - batches.length : 0;

  function clearSkipped() {
    try { localStorage.removeItem(SKIPPED_BATCHES_KEY); } catch { /* a convenience, nothing depends on it */ }
    setSkipped(skippedCount());
  }

  return (
    <div id="work-queue">
      <div className="wq-header">
        <span className="wq-label">Work queue</span>
        {head && (
          <span className="wq-totals">
            {/* batched_photos is the union the listed batches cover; the tail is
                called out so this and "N remaining" above still add up. */}
            {head.total_batches.toLocaleString()} batch{head.total_batches === 1 ? "" : "es"} · {head.batched_photos.toLocaleString()} photos
            {head.tail_photos ? `  (${head.tail_photos.toLocaleString()} more not worth batching)` : ""}
          </span>
        )}
        <div className="wq-kinds">
          <SegmentedToggle<Kind>
            label="Batch kind" value={kind} onChange={setKind}
            options={[{ value: "all", label: "All" }, { value: "session", label: "Sessions" }, { value: "folder", label: "Folders" }]}
          />
        </div>
      </div>
      <div id="wq-list">
        {q.isPending ? (
          // The first build on a cold cache sweeps the whole library, so say so.
          <div className="wq-status"><Spinner /> Building the queue…</div>
        ) : batches.length ? (
          <ul>{batches.map((b) => <BatchRow key={b.id} b={b} />)}</ul>
        ) : head ? (
          <div className="wq-status">
            {head.total_photos ? "Nothing big enough to batch — use the month bars below." : "Everything is tagged. 🎉"}
          </div>
        ) : null}
      </div>
      {q.isError && <div className="error-line" role="alert">Error: {q.error.message}</div>}
      <div className="wq-footer">
        {q.hasNextPage && (
          <button type="button" id="wq-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? <><Spinner /> Loading…</> : `Show ${Math.min(PAGE, left)} more`}
          </button>
        )}
        {skipped > 0 && (
          <button type="button" id="wq-clear-skipped" onClick={clearSkipped}
            title="Batches passed over with Skip are hidden from Next batch until this is cleared">
            Clear skipped ({skipped})
          </button>
        )}
      </div>
    </div>
  );
}
