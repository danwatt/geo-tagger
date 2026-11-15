import { useEffect, useMemo, useRef, useState } from "react";
import type { Schemas } from "../api/client";
import { getJson } from "../api/client";
import { latestOnly } from "../lib/latestOnly";
import "./LocationPicker.css";

/* Saved-place and photo-metadata autocomplete over /api/search/locations
 * (offline: saved places + locations already in the library). Port of
 * location-picker.js as an ARIA combobox: the input owns focus, arrows move the
 * active option (aria-activedescendant), Enter picks it, Escape closes.
 *
 * The caller owns the text (`value` / `onTextChange`) and what a pick means.
 * Typing after a pick calls onEdit first, so the caller can drop the stale
 * selection — the text no longer names it. */

export type LocationItem = Schemas["LocationSuggestion"];

const DEBOUNCE_MS = 180;

type Box =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "list"; items: LocationItem[] };

export function optionDetail(item: LocationItem): string {
  return item.kind === "place"
    ? "Saved place · GPS boundary"
    : `Photo location · ${item.level ?? ""} · ${(item.count ?? 0).toLocaleString()} photos`;
}

export function LocationPicker({
  id, value, onTextChange, onSelect, onEdit, placeholder, describedBy, emptyMessage, errorMessage,
}: {
  id: string;
  value: string;
  onTextChange: (text: string) => void;
  onSelect: (item: LocationItem) => void;
  onEdit: () => void;
  placeholder?: string;
  describedBy?: string;
  emptyMessage: string;
  errorMessage: string;
}) {
  const listId = `${id}-suggest`;
  const [box, setBox] = useState<Box>({ kind: "closed" });
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Latest-only: each keystroke's reply supersedes the last, and close() cancels
  // a reply still in flight so it can't reopen the box.
  const suggest = useMemo(() => latestOnly(async (signal: AbortSignal) => {
    setBox({ kind: "loading" });
    setActive(-1);
    try {
      const q = encodeURIComponent(valueRef.current.trim());
      const data = await getJson<Schemas["LocationsResponse"]>(`/api/search/locations?q=${q}`, { signal });
      if (signal.aborted) return;
      setBox({ kind: "list", items: data.locations });
    } catch {
      if (signal.aborted) return;
      setBox({ kind: "error" });
    }
  }), []);

  useEffect(() => () => { suggest.cancel(); clearTimeout(timer.current); }, [suggest]);

  function close() {
    suggest.cancel();
    clearTimeout(timer.current);
    setBox({ kind: "closed" });
    setActive(-1);
  }

  function choose(item: LocationItem) {
    onTextChange(item.label);
    close();
    onSelect(item);
  }

  const items = box.kind === "list" ? box.items : [];
  const open = box.kind !== "closed";

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && open) {
      close();
      e.stopPropagation();
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && open && items.length) {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    }
    if (e.key === "Enter" && open && active >= 0 && items[active]) {
      // Handled here: the form's Enter-to-search must not also fire.
      e.preventDefault();
      e.stopPropagation();
      choose(items[active]);
    }
  }

  return (
    <>
      <input
        type="text"
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-option-${active}` : undefined}
        aria-describedby={describedBy}
        onFocus={() => void suggest()}
        onBlur={close}
        onChange={(e) => {
          onTextChange(e.target.value);
          close();
          onEdit();
          timer.current = setTimeout(() => void suggest(), DEBOUNCE_MS);
        }}
        onKeyDown={onKeyDown}
      />
      <div id={listId} ref={listRef} className="location-suggestions" role="listbox" hidden={!open}>
        {box.kind === "loading" && "Loading locations…"}
        {box.kind === "error" && errorMessage}
        {box.kind === "list" && !items.length && emptyMessage}
        {items.map((item, i) => (
          <div
            key={`${item.kind}-${item.id ?? item.label}-${i}`}
            id={`${listId}-option-${i}`}
            className="location-option"
            role="option"
            aria-selected={i === active}
            // mousedown would blur the input (closing the list) before the click lands.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(item)}
          >
            <strong>{item.label}</strong>
            <span>{optionDetail(item)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
