import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

/** Render inside a fresh QueryClient (no retries, so failures surface at once). */
export function renderWithQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

type Route = (req: { url: string; method: string; query: URLSearchParams; body?: unknown }) => unknown;

/** Stub global fetch with a map of "METHOD /path" → handler returning a JSON body,
 *  or a Response for non-200s. Unmatched requests fail the test loudly. */
export function mockApi(routes: Record<string, Route>) {
  const calls: { method: string; url: string; query: URLSearchParams; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
    const parsed = new URL(req.url);
    const url = parsed.pathname;
    const query = parsed.searchParams;
    const method = req.method.toUpperCase();
    const text = method === "GET" || method === "HEAD" ? "" : await req.clone().text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    calls.push({ method, url, query, body });
    const handler = routes[`${method} ${url}`];
    if (!handler) throw new Error(`Unmocked request: ${method} ${url}`);
    const out = handler({ url, method, query, body });
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
