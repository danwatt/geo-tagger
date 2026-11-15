/* Per-camera colours for the grid stripes, the pins and the legend. Port of
 * camera-colors.js: a camera keeps the colour it was first given for the life
 * of the page, so the legend order and the stripes stay stable across scopes. */

export const CAM_PALETTE = [
  "#e05c5c", // red
  "#e0a040", // amber
  "#d4d43a", // yellow
  "#5cb85c", // green
  "#3ab8b8", // teal
  "#4a90d9", // blue
  "#9b5ce0", // purple
  "#e05cbc", // pink
  "#e07840", // orange
  "#7ab85c", // lime
];

export class CameraColors {
  private map = new Map<string, string>();

  color(camera: string | null | undefined): string {
    const key = camera || "Unknown";
    let c = this.map.get(key);
    if (!c) {
      c = CAM_PALETTE[this.map.size % CAM_PALETTE.length]!;
      this.map.set(key, c);
    }
    return c;
  }

  /** Cameras of `photos`, in first-assignment order (pre-assigning any new ones,
   *  in photo order, so the legend order is stable). */
  legend(photos: readonly { camera?: string | null }[]): { camera: string; color: string }[] {
    const present = new Set<string>();
    photos.forEach((p) => { this.color(p.camera); present.add(p.camera || "Unknown"); });
    return [...this.map].filter(([cam]) => present.has(cam)).map(([camera, color]) => ({ camera, color }));
  }
}
