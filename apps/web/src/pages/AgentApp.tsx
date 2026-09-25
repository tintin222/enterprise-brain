import { Bot } from "lucide-react";
import { useParams } from "react-router";
import { isApiError } from "../api.ts";
import { AgentAppView } from "../components/AgentAppView.tsx";
import { ButtonLink } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Page } from "../components/Layout.tsx";
import { ErrorState, LoadingBlock } from "../components/Spinner.tsx";
import { useAgent } from "../lib/queries.ts";

/** /apps/:slug — the generated app of an agent. */
export default function AgentApp() {
  const { slug } = useParams();
  const { data, isLoading, error, refetch } = useAgent(slug);
  return (
    <Page>
      {isLoading && <LoadingBlock label="Opening the app…" />}
      {isApiError(error, 404) && (
        <EmptyState
          icon={Bot}
          title="This AI employee doesn't exist"
          description="It may have been removed, or it belongs to another company."
          action={
            <ButtonLink to="/company" variant="primary">
              All agents
            </ButtonLink>
          }
        />
      )}
      {error && !isApiError(error, 404) && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && <AgentAppView detail={data} />}
    </Page>
  );
}
