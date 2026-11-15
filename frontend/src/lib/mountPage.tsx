import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// The legacy design system, shared with unported pages until the migration ends:
// tokens, reset, form controls, #toolbar / #status-bar / nav / scan-banner chrome.
import "../../../src/geotagger/web/theme.css";
import "./page.css";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      // A local single-user app: data only changes when this user changes it, so
      // don't refetch on every window focus. Mutations invalidate what they touch.
      queries: { refetchOnWindowFocus: false, retry: 1 },
    },
  });
}

/** Render a page into #root with the providers every page needs. */
export function mountPage(page: ReactNode) {
  const el = document.getElementById("root");
  if (!el) throw new Error("#root missing from the page HTML");
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>{page}</QueryClientProvider>
    </StrictMode>,
  );
}
