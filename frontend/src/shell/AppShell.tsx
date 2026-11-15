import type { ReactNode } from "react";
import { NavBar } from "./NavBar";
import { ScanBanner } from "./ScanBanner";

/* Page chrome shared by every ported page: the #toolbar (nav plus optional
 * page-specific controls), the scan banner under it, then the page body. Uses
 * theme.css's ids and classes so it matches the legacy pages exactly. Pages that
 * need a status bar render <StatusBar> themselves, as its last child. */

export function AppShell({ active, toolbar, children }: { active: string; toolbar?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div id="toolbar">
        <NavBar active={active} />
        {toolbar}
      </div>
      <ScanBanner />
      {children}
    </>
  );
}
