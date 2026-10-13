import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Download, FolderTree, Package, TerminalSquare } from "lucide-react";
import { downloadWithAuth } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, CardBody, CardHeader } from "../../components/Card.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { formatBytes, formatDateTime, plural } from "../../lib/format.ts";
import { keys, useProjectPackage } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ProjectView } from "../../types.ts";

const SOURCE_WORDS = { studio: "designed with the Studio agent", interview: "designed in an interview", attached: "attached as a model" };

/** The development package: what it will hold, and the download Claude Code builds from. */
export function PackageTab({ project }: { project: ProjectView }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const preview = useProjectPackage(project.id);
  const download = useMutation({
    mutationFn: () => downloadWithAuth(path(`/projects/${project.id}/package.zip`), `${project.slug}-dev-package.zip`),
    onSuccess: async () => {
      toast.success("Package downloaded", { description: "Unzip it and open the folder in Claude Code." });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.project(company, project.slug) }),
        queryClient.invalidateQueries({ queryKey: keys.projects(company) }),
      ]);
    },
    onError: (error) => toast.error(error),
  });
  const summary = preview.data?.summary;
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card>
          <CardHeader
            title="The development package"
            icon={Package}
            subtitle="A folder a developer, or Claude Code, builds this project's AI employees from, outside the platform. No code inside: the job, the rules, the company's context, the data and the plan."
            actions={
              <Button variant="primary" icon={Download} loading={download.isPending} onClick={() => download.mutate()}>
                Download the package
              </Button>
            }
          />
          <CardBody className="space-y-3 text-sm text-muted">
            <p>
              {project.lastExportedAt ? (
                <>
                  Last exported {formatDateTime(project.lastExportedAt)} ({plural(project.exports, "time")}). Each download is made fresh from the project as it
                  stands.
                </>
              ) : (
                "Not exported yet. Each download is made fresh from the project as it stands."
              )}
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Unzip it and open the folder in Claude Code. CLAUDE.md tells it what to build and the rules to keep.</li>
              <li>
                It starts from <span className="font-mono text-xs text-fg">tasks/PLAN.md</span>, then each AI employee's{" "}
                <span className="font-mono text-xs text-fg">SPEC.md</span>.
              </li>
              <li>
                To ask the live company brain while building, set <span className="font-mono text-xs text-fg">EB_API_KEY</span> in the environment: the
                package's <span className="font-mono text-xs text-fg">.mcp.json</span> connects Claude Code to this platform. The key itself is never in the
                package.
              </li>
            </ol>
          </CardBody>
        </Card>
        {preview.error && <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />}
        {preview.isLoading && <Skeleton className="h-40" />}
        {summary && (
          <Card>
            <CardHeader title="What it holds" icon={FolderTree} subtitle={`${plural(summary.files, "file")} · ${formatBytes(summary.bytes)}`} />
            <ul className="divide-y divide-line">
              {summary.folders.map((f) => (
                <li key={f.folder} className="flex items-start gap-3 px-5 py-2.5 text-sm">
                  <span className="w-28 shrink-0 font-mono text-xs text-fg">{f.folder}</span>
                  <span className="min-w-0 flex-1 text-muted">{f.what}</span>
                  <Badge tone={f.files ? "brand" : "neutral"} size="xs">
                    {f.files}
                  </Badge>
                </li>
              ))}
              <li className="flex items-start gap-3 px-5 py-2.5 text-sm">
                <span className="w-28 shrink-0 font-mono text-xs text-fg">CLAUDE.md</span>
                <span className="min-w-0 flex-1 text-muted">
                  what to build, the rules, where everything is, how to reach the live brain; with README.md, project.json and .mcp.json
                </span>
              </li>
            </ul>
          </Card>
        )}
      </div>
      <div className="space-y-6">
        {summary && (
          <Card>
            <CardHeader title="AI employees in it" icon={Bot} />
            {summary.agents.length ? (
              <ul className="divide-y divide-line">
                {summary.agents.map((a) => (
                  <li key={a.slug} className="px-5 py-2.5 text-sm">
                    <p className="font-medium text-fg">{a.name}</p>
                    <p className="text-xs text-muted">
                      agents/{a.slug}/ · {SOURCE_WORDS[a.source]}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <CardBody>
                <p className="text-sm text-muted">
                  None yet: a design saves one when the Studio writes its job. The brain context, data and documents go in meanwhile.
                </p>
              </CardBody>
            )}
          </Card>
        )}
        {summary && summary.warnings.length > 0 && (
          <Card>
            <CardHeader title="Left out" icon={AlertTriangle} />
            <ul className="divide-y divide-line">
              {summary.warnings.map((w) => (
                <li key={w} className="px-5 py-2.5 text-sm text-muted">
                  {w}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {summary && (
          <Card>
            <CardHeader title="The live brain over MCP" icon={TerminalSquare} />
            <CardBody className="space-y-2 text-sm text-muted">
              <p>Claude Code can ask what the company knows while it builds, and read the AI employees at work here.</p>
              <p className="break-all font-mono text-xs text-fg">{summary.mcpUrl}</p>
              <p>
                Tools: company_search, company_open, knowledge_search, list_agents, get_run, list_approvals. Needs the platform's machine key as EB_API_KEY; ask
                IT.
              </p>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
