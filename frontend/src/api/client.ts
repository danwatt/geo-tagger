/* Typed API client. Paths, params and bodies are checked against schema.d.ts,
 * which `npm run gen:api` generates from the FastAPI routes. Routes without a
 * response_model come back as `unknown`-ish types; add one in the router when a
 * page starts relying on a response's shape. */

import createClient from "openapi-fetch";
import type { paths, components } from "./schema";
import { ApiError } from "./errors";

export type Schemas = components["schemas"];

export const api = createClient<paths>({
  // Absolute: openapi-fetch builds a Request, and Node's Request (used under
  // Vitest/jsdom) rejects relative URLs that browsers would resolve.
  baseUrl: globalThis.location.origin,
  // Resolve fetch at call time (not at module load) so tests can stub it.
  fetch: (request) => globalThis.fetch(request),
});

/** GET a JSON route by a runtime path (openapi-fetch needs a literal path for its
 *  types). For generic helpers like useJob, and for callers that must replay an
 *  exact query string (Search's Load more); prefer `api.GET` elsewhere. `init`
 *  carries an AbortSignal for latest-only loaders. */
export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await globalThis.fetch(path, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/** For "start a background job" POSTs: OK, or 409 = one is already running
 *  (fine, the caller polls it either way); anything else throws. */
export function acceptStarted(result: { error?: unknown; response: Response }): void {
  if (result.response.ok || result.response.status === 409) return;
  throw new ApiError(result.response.status, result.error);
}

/** Unwrap an openapi-fetch result: the data, or throw ApiError with the
 *  server's message. Mirrors common.js fetchJson's "check res.ok first". */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (!result.response.ok || result.data === undefined) {
    throw new ApiError(result.response.status, result.error);
  }
  return result.data;
}
