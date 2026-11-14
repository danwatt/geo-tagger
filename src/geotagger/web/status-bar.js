/* Shared #status-bar writer for the pages that colour the bar inline
 * (Geocode, Time Sync, People, Photo Faces). Pages that style errors with an
 * `.error` class (Map, Custom Places, Representatives, Search) keep their own
 * setStatus and must NOT load this file.
 */

/* ── Status ── */
// Whether the bar currently shows an error — lets a later generic hint (e.g. the
// People page's post-init "Select a person…") avoid painting over a load failure.
let statusIsError = false;

function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#f88" : "#888";
  statusIsError = isError;
}
