import { usePluginData, type PluginPageProps, type PluginSidebarProps, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { PAGE_ROUTE } from "../manifest.ts";

interface BridgeConfig {
  url: string | null;
  company: string;
}

interface Summary {
  ok: boolean;
  counts?: Record<string, number>;
  costMonthUsd?: number;
  error?: string;
}

const box: React.CSSProperties = { border: "1px solid rgba(127,127,127,.25)", borderRadius: 12, padding: 16 };
const links = [
  { label: "Agent Builder", path: "/builder/new" },
  { label: "Catalog", path: "/catalog" },
  { label: "Approvals", path: "/approvals" },
  { label: "Inbox", path: "/inbox" },
  { label: "Knowledge", path: "/knowledge" },
];

/** Full page: the Enterprise Brain console embedded in Paperclip, with quick links. */
export function EnterpriseBrainPage({ context }: PluginPageProps) {
  const { data, loading } = usePluginData<BridgeConfig>("config", { companyId: context.companyId ?? "" });
  if (loading) return <div style={{ padding: 24 }}>Loading Enterprise Brain…</div>;
  if (!data?.url) {
    return (
      <div style={{ padding: 24, maxWidth: 640 }}>
        <h2 style={{ marginTop: 0 }}>Enterprise Brain</h2>
        <p>Set the Enterprise Brain URL in this plugin's settings to embed the console here (Agent Builder, department catalog, approvals).</p>
      </div>
    );
  }
  const base = data.url.replace(/\/$/, "");
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 80px)", gap: 12, padding: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ marginRight: 8 }}>Enterprise Brain</strong>
        {links.map((l) => (
          <a key={l.path} href={`${base}${l.path}`} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
            {l.label} ↗
          </a>
        ))}
      </div>
      <iframe title="Enterprise Brain" src={`${base}/?embed=paperclip`} style={{ flex: 1, width: "100%", border: 0, borderRadius: 12 }} />
    </div>
  );
}

export function EnterpriseBrainSidebarLink({ context }: PluginSidebarProps) {
  const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
  return <a href={`${prefix}/${PAGE_ROUTE}`}>🧠 Enterprise Brain</a>;
}

/** Dashboard widget: live counts from Enterprise Brain. */
export function EnterpriseBrainWidget({ context }: PluginWidgetProps) {
  const { data, loading } = usePluginData<Summary>("summary", { companyId: context.companyId ?? "" });
  if (loading) return <div style={box}>Enterprise Brain…</div>;
  if (!data?.ok) return <div style={box}>Enterprise Brain unreachable{data?.error ? `: ${data.error}` : ""}</div>;
  const c = data.counts ?? {};
  return (
    <div style={box}>
      <strong>Enterprise Brain</strong>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 8, fontSize: 13 }}>
        <span>Active agents: {c.activeAgents ?? 0}</span>
        <span>Runs (24h): {c.runs24h ?? 0}</span>
        <span>Pending approvals: {c.pendingApprovals ?? 0}</span>
        <span>Cost this month: ${data.costMonthUsd ?? 0}</span>
      </div>
    </div>
  );
}
