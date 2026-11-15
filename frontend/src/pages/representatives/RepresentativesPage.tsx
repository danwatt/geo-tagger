import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../api/client";
import { FaceCrop } from "../../photos/FaceCrop";
import { GroupHeader } from "../../photos/GroupHeader";
import { AppShell } from "../../shell/AppShell";
import { StatusBar, type Status } from "../../shell/StatusBar";
import "./representatives.css";

/* Representative Faces review page: pick a person, see each kept representative
 * face grouped with the other labeled faces closest to it (see
 * faces.get_representative_groups / the "Representative faces" settings group).
 * Port of web/representatives.js. The groups query is keyed by person, so
 * clicking person A then B only ever shows B's groups (the latest-only rule
 * the legacy loader enforced by hand). */

type DedupPerson = Schemas["DedupPerson"];
type Group = Schemas["DedupGroup"];

const PERSONS_KEY = ["faces", "dedup", "persons"] as const;
const groupsKey = (personId: number) => ["faces", "dedup", "groups", personId] as const;

const NO_PERSONS_HINT = "No one has representative faces yet — click “Recompute representatives” above " +
  "(only applies to people with enough labeled faces; see Settings).";

/** The status line for a person's loaded groups. */
export function groupsStatus(groups: readonly Group[], total: number): string {
  if (!groups.length) return "No representative groups for this person yet — try Recompute.";
  const shown = groups.reduce((sum, g) => sum + 1 + g.others.length, 0);
  return `${groups.length} group(s), ${shown} of ${total} face(s) shown.`;
}

/** The status line after a recompute. */
export function recomputeStatus(persons: readonly Schemas["RepresentativeCounts"][]): string {
  if (!persons.length) return "No one has enough labeled faces yet (see Settings for the threshold).";
  const totalFaces = persons.reduce((sum, p) => sum + p.total, 0);
  const totalReps = persons.reduce((sum, p) => sum + p.representative, 0);
  return `${persons.length} people processed: ${totalFaces.toLocaleString()} labeled faces -> ${totalReps.toLocaleString()} representatives.`;
}

function GroupCard({ group: g, index }: { group: Group; index: number }) {
  const shownCount = 1 + g.others.length;
  const labelId = `rep-group-${index}`;
  return (
    <section className="rep-group-card" aria-labelledby={labelId}>
      <GroupHeader id={labelId} title={`Group of ${g.size}`}
        meta={g.others.length < g.size - 1 ? `· showing ${shownCount}` : undefined} />
      <div className="rep-group-faces">
        {/* The representative itself: distinct border + badge so it reads as
            "the one kept" at a glance among its near-duplicates. */}
        <div className="rep-face-wrap">
          <FaceCrop face={g.representative} title="Representative"
            alt={`Representative: ${g.representative.filename || "face"}`} />
          <span className="rep-face-badge" aria-hidden="true">★</span>
        </div>
        {g.others.map((f) => <FaceCrop key={f.id} face={f} title={f.filename ?? undefined} />)}
        {g.size > shownCount && <span className="rep-group-more">+{g.size - shownCount} more</span>}
      </div>
    </section>
  );
}

export function RepresentativesPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ message: "" });

  const persons = useQuery({
    queryKey: PERSONS_KEY,
    queryFn: async () => unwrap(await api.GET("/api/faces/dedup/persons")),
  });
  const groups = useQuery({
    queryKey: groupsKey(selected ?? -1),
    queryFn: async ({ signal }) => unwrap(await api.GET("/api/faces/dedup/groups", {
      params: { query: { person_id: selected! } }, signal,
    })),
    enabled: selected !== null,
  });

  const personsError = persons.isError ? persons.error.message : null;
  useEffect(() => {
    if (personsError) setStatus({ message: "Failed to load people: " + personsError, isError: true });
  }, [personsError]);

  // The status line follows the selected person's groups: loading, failed or
  // loaded (and again after a recompute refetches them).
  const groupsError = groups.isError ? groups.error.message : null;
  useEffect(() => {
    if (selected === null) return;
    if (groups.isFetching) setStatus({ message: "Loading groups…" });
    else if (groupsError) setStatus({ message: "Failed to load groups: " + groupsError, isError: true });
    else if (groups.data) setStatus({ message: groupsStatus(groups.data.groups, groups.data.total) });
  }, [selected, groups.isFetching, groupsError, groups.data, groups.dataUpdatedAt]);

  const recompute = useMutation({
    mutationFn: async () => unwrap(await api.POST("/api/faces/dedup/recompute")),
    onMutate: () => setStatus({ message: "Recomputing representative faces…" }),
    onSuccess: async (data) => {
      setStatus({ message: recomputeStatus(data.persons) });
      await qc.invalidateQueries({ queryKey: PERSONS_KEY });
      if (selected !== null) await qc.invalidateQueries({ queryKey: groupsKey(selected) });
    },
    onError: (e) => setStatus({ message: "Recompute failed: " + e.message, isError: true }),
  });

  const list: DedupPerson[] = persons.data ?? [];
  // Stale groups stay out of view while another person's load: only the
  // selected person's own data is ever drawn.
  const shownGroups = selected !== null && !groups.isError && groups.data ? groups.data.groups : [];

  return (
    <AppShell active="representatives" toolbar={
      <>
        <div className="toolbar-spacer" />
        <div className="toolbar-group">
          <button type="button" id="recompute-btn" disabled={recompute.isPending} onClick={() => recompute.mutate()}>
            {recompute.isPending ? "Recomputing…" : "Recompute representatives"}
          </button>
        </div>
      </>
    }>
      <div id="main">
        <nav id="sidebar" aria-labelledby="rep-people-title">
          <div id="sidebar-header">
            <h2 id="rep-people-title">People</h2>
          </div>
          <div id="person-list">
            {persons.data && !list.length && <div id="no-persons-hint">{NO_PERSONS_HINT}</div>}
            {list.map((p) => (
              <button key={p.person_id} type="button" aria-pressed={p.person_id === selected}
                className={`person-item${p.person_id === selected ? " selected" : ""}`}
                onClick={() => setSelected(p.person_id)}>
                <span className="person-item-name">{p.name}</span>
                <span className="person-item-count" aria-label={`${p.representative} representative of ${p.total} faces`}>
                  {p.representative} / {p.total}
                </span>
              </button>
            ))}
          </div>
        </nav>

        <main id="groups-pane" aria-busy={groups.isFetching || undefined}>
          {selected === null && <div id="groups-empty">Pick a person on the left to review their representative groups.</div>}
          <div id="groups-grid">
            {shownGroups.map((g, i) => <GroupCard key={g.representative.id} group={g} index={i} />)}
          </div>
        </main>
      </div>
      <StatusBar status={status} />
    </AppShell>
  );
}
