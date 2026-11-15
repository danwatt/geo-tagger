/* The per-face thumbnail <img>. Port of face-grid.js faceCropImg (without its
 * node-reuse cache: React keeps a mounted <img> across re-renders by itself). */

export function FaceCrop({ face, title, alt }: {
  face: { id: number; filename?: string | null };
  title?: string;
  alt?: string;
}) {
  return <img src={`/api/faces/${face.id}/crop`} loading="lazy" alt={alt || face.filename || "face"} title={title} />;
}
