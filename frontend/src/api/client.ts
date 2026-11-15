/* Typed API client. Paths, params and bodies are checked against schema.d.ts,
 * which `npm run gen:api` generates from the FastAPI routes. Routes without a
 * response_model come back as `unknown`-ish types; add one in the router when a
 * page starts relying on a response's shape. */

import createClient from "openapi-fetch";
import type { paths, components } from "./schema";
import { ApiError } from "./errors";

export type Schemas = components["schemas"];

export const api = createClient<paths>({
  // Resolve fetch at call time (not at module load) so tests can stub it.
  fetch: (request) => globalThis.fetch(request),
});

/** Unwrap an openapi-fetch result: the data, or throw ApiError with the
 *  server's message. Mirrors common.js fetchJson's "check res.ok first". */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (!result.response.ok || result.data === undefined) {
    throw new ApiError(result.response.status, result.error);
  }
  return result.data;
}
