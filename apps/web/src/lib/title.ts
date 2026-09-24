import { useEffect } from "react";

/** Sets the browser tab title: "Agents · Enterprise Brain". */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Enterprise Brain` : "Enterprise Brain";
  }, [title]);
}
