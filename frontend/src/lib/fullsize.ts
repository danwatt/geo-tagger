/* "View full size (RAW)". Port of photo-fullsize.js.
 *
 * The served preview (/api/preview/{id}) is the fast *embedded* JPEG for RAW
 * files, so it looks soft. The full LibRaw demosaic (with face boxes drawn) is a
 * separate, heavier render at /api/photos/{id}/fullsize, offered only on RAW
 * photos — for non-RAW the served preview is already the real image.
 * RAW_EXTS mirrors config.RAW_EXTENSIONS on the backend; keep them in sync. */

const RAW_EXTS = [".nef", ".dng"];

/** True when a filename or bare extension is a supported RAW type (case-insensitive). */
export function isRawName(nameOrExt: string | null | undefined): boolean {
  if (!nameOrExt) return false;
  const s = nameOrExt.toLowerCase();
  return RAW_EXTS.some((e) => s.endsWith(e));
}

export function fullSizeUrl(photoId: number): string {
  return `/api/photos/${photoId}/fullsize`;
}
