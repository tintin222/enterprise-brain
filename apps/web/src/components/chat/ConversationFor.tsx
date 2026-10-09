import { clsx } from "clsx";
import { useConversationFor, type ForKind } from "../../lib/queries.ts";
import { ErrorState, Spinner } from "../Spinner.tsx";
import { ConversationView, type ConversationViewProps } from "./ConversationView.tsx";

/** The conversation about a task, a thing, an AI employee (my talk), a person (our direct message) or a message (its thread), made on first use. */
export function ConversationFor({ kind, about, className, ...rest }: { kind: ForKind; about: string } & Omit<ConversationViewProps, "id">) {
  const found = useConversationFor(kind, about);
  if (found.isLoading) {
    return (
      <div className={clsx("flex items-center justify-center", className)}>
        <Spinner />
      </div>
    );
  }
  if (found.error || !found.data) {
    return (
      <div className={clsx("p-6", className)}>
        <ErrorState error={found.error} onRetry={() => void found.refetch()} />
      </div>
    );
  }
  return <ConversationView key={found.data.conversation.id} id={found.data.conversation.id} className={className} {...rest} />;
}
