import { UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { useIsManager } from "../lib/auth.tsx";
import { paths } from "../lib/paths.ts";
import { ButtonLink } from "./Button.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Page } from "./Layout.tsx";

/** Pages for managers and IT (building an AI employee): everyone else learns who does it, instead of an error. */
export function ForManagers({ children }: { children: ReactNode }) {
  const manager = useIsManager();
  if (manager) return <>{children}</>;
  return (
    <Page>
      <EmptyState
        icon={UserPlus}
        title="Managers build AI employees"
        description="A manager of your department builds AI employees in the Studio. Ask yours, or see how each AI employee is set up under AI employees."
        action={
          <ButtonLink to={paths.home("studio")} variant="primary">
            Studio home
          </ButtonLink>
        }
      />
    </Page>
  );
}
