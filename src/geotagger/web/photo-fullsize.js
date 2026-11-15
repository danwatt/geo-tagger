/* Shared "View full size (RAW)" affordance.
 *
 * The served preview (/api/preview/{id}) is the fast *embedded* JPEG for RAW
 * files, so it looks soft. The full LibRaw demosaic (with face boxes drawn) is a
 * separate, heavier render at /api/photos/{id}/fullsize. We surface a button for it
 * only on RAW photos, matching that tradeoff — for non-RAW the served preview is
 * already the real image.
 *
 * RAW_EXTS mirrors config.RAW_EXTENSIONS on the backend; keep them in sync. */
(function () {
  const RAW_EXTS = [".nef", ".dng"];

  // True when a filename OR bare extension is a supported RAW type (case-insensitive).
  window.isRawName = function (nameOrExt) {
    if (!nameOrExt) return false;
    const s = String(nameOrExt).toLowerCase();
    return RAW_EXTS.some((e) => s.endsWith(e));
  };

  window.openFullSize = function (photoId) {
    window.open(`/api/photos/${photoId}/fullsize`, "_blank");
  };

  /* Show `btn` only for RAW photos and wire its click to the full-size render.
   * stopPropagation keeps it safe inside click-to-close overlays (Quick Tag). */
  window.wireFullSizeButton = function (btn, filename, photoId) {
    if (!btn) return;
    const raw = window.isRawName(filename);
    btn.style.display = raw ? "" : "none";
    btn.onclick = raw
      ? (e) => { e.stopPropagation(); window.openFullSize(photoId); }
      : null;
  };
})();