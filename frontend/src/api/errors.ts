/* One readable line from an API error body. Port of common.js httpErrorText:
 * FastAPI sends `detail` as a string (HTTPException), an object with a
 * `message` (structured 409s), or a list of validation problems (422). */

type ValidationItem = { loc?: unknown; msg?: unknown };

export function httpErrorText(body: unknown, status: number): string {
  const d = (body as { detail?: unknown } | null | undefined)?.detail;
  if (typeof d === "string" && d) return d;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const message = (d as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  if (Array.isArray(d) && d.length) {
    const first = d[0] as ValidationItem;
    if (typeof first.msg === "string") {
      // A 422 validation list: the first problem, with where it was ("values → KEY").
      const loc = Array.isArray(first.loc) ? first.loc.filter((x) => x !== "body").join(" → ") : "";
      return `${loc ? loc + ": " : ""}${first.msg}`;
    }
  }
  return `HTTP ${status}`;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(httpErrorText(body, status));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}
