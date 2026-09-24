import { CircleCheck, UserCheck } from "lucide-react";
import { useState } from "react";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { PageHeader } from "../components/Card.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Page } from "../components/Layout.tsx";
import { ErrorState, Skeleton } from "../components/Spinner.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { useApprovals } from "../lib/queries.ts";

export default function Approvals() {
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const pending = useApprovals("pending", 10_000);
  const all = useApprovals(undefined, 30_000);
  const decided = (all.data ?? []).filter((a) => a.status !== "pending");
  const query = tab === "pending" ? pending : all;
  const list = tab === "pending" ? (pending.data ?? []) : decided;

  return (
    <Page className="max-w-5xl">
      <PageHeader
        icon={UserCheck}
        title="Approvals"
        description="Agents prepare; people decide. Anything that changes a business system, sends an email or needs a judgement waits here until someone approves it."
      />
      <Tabs
        className="mb-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "pending", label: "Pending", count: pending.data?.length ?? 0, alert: (pending.data?.length ?? 0) > 0 },
          { id: "decided", label: "Decided", count: decided.length },
        ]}
      />
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.isLoading && (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      )}
      {!query.isLoading && list.length === 0 && (
        <EmptyState
          icon={tab === "pending" ? CircleCheck : UserCheck}
          title={tab === "pending" ? "You're all caught up" : "No decisions yet"}
          description={
            tab === "pending"
              ? "When an agent wants to write to a business system, send an email or needs a decision, it pauses and asks here."
              : "Approved and rejected requests are kept here as an audit trail."
          }
        />
      )}
      <div className="space-y-4">
        {list.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
      </div>
    </Page>
  );
}
