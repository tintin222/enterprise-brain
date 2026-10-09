import { useEffect } from "react";
import { portalOf } from "./paths.ts";

/** Sets the browser tab title: "Agents · Enterprise Brain", "Brain · Studio · Enterprise Brain" in the Studio. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    const portal = portalOf(window.location.pathname) === "studio" ? " · Studio" : "";
    document.title = title ? `${title}${portal} · Enterprise Brain` : `Enterprise Brain${portal}`;
  }, [title]);
}
