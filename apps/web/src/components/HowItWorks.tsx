import { List, Workflow } from "lucide-react";
import { useState } from "react";
import { useStoredFlag } from "../lib/preferences.ts";
import type { AgentDetail } from "../types.ts";
import { Card, CardHeader } from "./Card.tsx";
import { FlowView } from "./FlowView.tsx";
import { StepPanel } from "./StepPanel.tsx";
import { Segmented } from "./Tabs.tsx";
import { WorkflowView } from "./WorkflowView.tsx";

/**
 * How an AI employee works, as a flow (what starts it, its steps, decisions side by side, loops framed)
 * or as a list; a step opens its settings, which its managers change there.
 */
export function HowItWorks({ detail }: { detail: AgentDetail }) {
  const [asFlow, setAsFlow] = useStoredFlag("eb.howItWorks.flow", () => true);
  const [open, setOpen] = useState<string | null>(null);
  const steps = detail.definition.workflow;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="How it works"
        icon={Workflow}
        subtitle={steps.length ? "Its steps for each task. Open one to see or change its settings." : "It works each task out with what it may use."}
        actions={
          steps.length ? (
            <Segmented<"flow" | "list">
              value={asFlow ? "flow" : "list"}
              onChange={(v) => setAsFlow(v === "flow")}
              options={[
                {
                  value: "flow",
                  label: (
                    <span className="inline-flex items-center gap-1">
                      <Workflow className="size-3.5" /> Flow
                    </span>
                  ),
                },
                {
                  value: "list",
                  label: (
                    <span className="inline-flex items-center gap-1">
                      <List className="size-3.5" /> List
                    </span>
                  ),
                },
              ]}
            />
          ) : undefined
        }
      />
      <div className="p-4 sm:p-5">
        {asFlow || !steps.length ? (
          <FlowView definition={detail.definition} selected={open} onSelect={steps.length ? setOpen : undefined} className="max-h-[42rem]" />
        ) : (
          <WorkflowView steps={steps} />
        )}
      </div>
      {open && (
        <StepPanel slug={detail.agent.slug} definition={detail.definition} stepId={open} canEdit={Boolean(detail.canManage)} onClose={() => setOpen(null)} />
      )}
    </Card>
  );
}
