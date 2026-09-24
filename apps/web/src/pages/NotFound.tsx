import { Compass } from "lucide-react";
import { ButtonLink } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Page } from "../components/Layout.tsx";

export default function NotFound() {
  return (
    <Page>
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="The link may be outdated. Use the navigation, or go back to the dashboard."
        action={
          <ButtonLink to="/" variant="primary">
            Dashboard
          </ButtonLink>
        }
      />
    </Page>
  );
}
