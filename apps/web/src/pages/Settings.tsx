import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building, KeyRound, Moon, Server, Settings as SettingsIcon, Sun } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, getApiKey, setApiKey } from "../api.ts";
import { Badge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Card, CardHeader, PageHeader } from "../components/Card.tsx";
import { Field } from "../components/Form.tsx";
import { KeyValue } from "../components/KeyValue.tsx";
import { Page } from "../components/Layout.tsx";
import { Callout } from "../components/Spinner.tsx";
import { Segmented } from "../components/Tabs.tsx";
import { useCompany } from "../lib/company.tsx";
import { useTheme } from "../lib/theme.ts";
import { useToast } from "../lib/toast.tsx";
import type { Company } from "../types.ts";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default function Settings() {
  const { info, company, companies, setCompany } = useCompany();
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState(getApiKey() ?? "");
  const [form, setForm] = useState({ name: "", slug: "" });

  const create = useMutation({
    mutationFn: () => api.post<Company>("/api/companies", { name: form.name.trim(), slug: form.slug || slugify(form.name) }),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: ["companies"] });
      toast.success(`Company “${c.name}” created`);
      setForm({ name: "", slug: "" });
      setCompany(c.slug);
    },
    onError: (e) => toast.error(e),
  });

  const saveKey = (e: FormEvent) => {
    e.preventDefault();
    setApiKey(key.trim() || null);
    void queryClient.resetQueries();
    toast.success(key.trim() ? "API key saved in this browser" : "API key removed");
  };

  return (
    <Page className="max-w-4xl">
      <PageHeader icon={SettingsIcon} title="Settings" description="This console's connection, company and appearance." />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Company" icon={Building} subtitle="All data in the console belongs to the selected company." />
          <div className="space-y-5 p-5">
            <Field label="Current company">
              {(id) => (
                <select id={id} className="input sm:max-w-sm" value={company} onChange={(e) => setCompany(e.target.value)}>
                  {companies.length === 0 && <option value={company}>{company}</option>}
                  {companies.map((c) => (
                    <option key={c.id} value={c.slug}>
                      {c.name} ({c.slug})
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (form.name.trim()) create.mutate();
              }}
              className="rounded-xl border border-line bg-subtle/40 p-4"
            >
              <p className="text-sm font-medium text-fg">Create a company</p>
              <p className="mb-3 text-xs text-muted">Each company has its own agents, knowledge, connectors and runs.</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
                <Field label="Name">
                  {(id) => (
                    <input
                      id={id}
                      className="input"
                      placeholder="Globex Holding"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Slug">
                  {(id) => (
                    <input
                      id={id}
                      className="input font-mono text-xs"
                      placeholder={slugify(form.name) || "globex"}
                      value={form.slug}
                      onChange={(e) => setForm({ ...form, slug: slugify(e.target.value) })}
                    />
                  )}
                </Field>
                <Button type="submit" variant="primary" loading={create.isPending} disabled={!form.name.trim()}>
                  Create
                </Button>
              </div>
            </form>
          </div>
        </Card>

        <Card>
          <CardHeader title="API access" icon={KeyRound} />
          <div className="p-5">
            {info.authRequired ? (
              <form onSubmit={saveKey} className="space-y-3">
                <Field label="Console API key" hint="Stored only in this browser (localStorage) and sent as Authorization: Bearer … with every request.">
                  {(id) => (
                    <input
                      id={id}
                      type="password"
                      autoComplete="off"
                      className="input sm:max-w-md"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      placeholder="EB_API_KEY"
                    />
                  )}
                </Field>
                <Button type="submit" variant="primary">
                  Save key
                </Button>
              </form>
            ) : (
              <Callout tone="info" title="Local trusted mode">
                This server runs without EB_API_KEY, so the console and the MCP endpoint need no key (like Paperclip's local_trusted mode). Set EB_API_KEY on
                the server to require one.
              </Callout>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Appearance" icon={theme === "dark" ? Moon : Sun} />
          <div className="p-5">
            <Segmented
              value={theme}
              onChange={setTheme}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Instance" icon={Server} />
          <div className="px-5 py-2">
            <KeyValue
              items={[
                ["Name", `${info.name} ${info.version}`],
                [
                  "Language model",
                  info.llm.available ? (
                    <Badge tone="green">
                      {info.llm.provider} · {info.llm.model}
                    </Badge>
                  ) : (
                    <span>
                      <Badge tone="amber">Offline mode</Badge>
                      <span className="ml-2 text-xs text-muted">Set ANTHROPIC_API_KEY for Claude; the platform runs with deterministic fallbacks.</span>
                    </span>
                  ),
                ],
                ["Embeddings", info.embeddings.model],
                ["Database", info.database],
                ["Public URL", info.publicUrl],
                ["Default company", info.defaultCompany],
                ["Paperclip", info.paperclip.configured ? info.paperclip.url : "Not configured (PAPERCLIP_URL)"],
                ["Authentication", info.authRequired ? "API key required" : "Local trusted mode"],
              ]}
            />
          </div>
        </Card>
      </div>
    </Page>
  );
}
