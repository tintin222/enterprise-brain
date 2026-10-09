import { Compass } from "lucide-react";
import { ButtonLink } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Page } from "../components/Layout.tsx";
import { paths, usePortal } from "../lib/paths.ts";

export default function NotFound() {
  const portal = usePortal();
  return (
    <Page>
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="The link may be outdated. Use the menu, or go back to the start."
        action={
          <ButtonLink to={paths.home(portal)} variant="primary">
            {portal === "studio" ? "Studio home" : "Home"}
          </ButtonLink>
        }
      />
    </Page>
  );
}
