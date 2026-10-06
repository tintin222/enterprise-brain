import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Link2, Lightbulb, MessageCircleQuestion, NotebookPen, Pencil, Plus, Share2, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, qs } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardBody, CardHeader } from "../../components/Card.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { timeAgo } from "../../lib/format.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import { useToast } from "../../lib/toast.tsx";
import type { BrainEntity, BrainEntitySummary, BrainLink, BrainModel, BrainRef, BrainRelation } from "../../types.ts";
import { KindIcon, ThingChip, brainKeys, kindOf, originName, useBrainEntities, useBrainEntity, useBrainModel, useMayEditBrain } from "./brain.tsx";
import { EntityForm } from "./EntityForm.tsx";
import { EventItem } from "./EventItem.tsx";
import { TellTheBrain } from "./TellTheBrain.tsx";
import { FieldValue } from "./values.tsx";

function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").toLowerCase().trim();
}

/** Names in steps ("Elif Arslan", "SAP S/4HANA", "Invoice Processor (AI)") → the things they name. */
function useNameLookup(entity: BrainEntity | undefined): (name: string) => BrainRef | undefined {
  const people = useBrainEntities("person");
  const systems = useBrainEntities("system");
  const ai = useBrainEntities("ai_employee");
  const roles = useBrainEntities("role");
  return useMemo(() => {
    const byName = new Map<string, BrainRef>();
    const add = (thing: BrainEntitySummary) => byName.set(fold(thing.name), { id: thing.id, kind: thing.kind, name: thing.name });
    for (const list of [roles.data, ai.data, systems.data, people.data]) for (const thing of list ?? []) add(thing);
    for (const link of entity?.links ?? []) add(link.other);
    return (name: string) => byName.get(fold(name)) ?? byName.get(fold(name.replace(/\s*\(AI\)$/i, "")));
  }, [entity, people.data, systems.data, ai.data, roles.data]);
}

function groupLinks(links: BrainLink[]): { key: string; label: string; links: BrainLink[] }[] {
  const groups = new Map<string, { key: string; label: string; links: BrainLink[] }>();
  for (const link of links) {
    const key = `${link.relation}:${link.direction}`;
    if (!groups.has(key)) groups.set(key, { key, label: link.label, links: [] });
    groups.get(key)!.links.push(link);
  }
  return [...groups.values()];
}

/** Relations that fit a thing of this kind, from its side ("out") or the other's ("in"). */
function relationOptions(model: BrainModel | undefined, kind: string): { relation: BrainRelation; direction: "out" | "in"; label: string }[] {
  const out: { relation: BrainRelation; direction: "out" | "in"; label: string }[] = [];
  for (const relation of model?.relations ?? []) {
    if (relation.from === "any" || relation.from.includes(kind)) out.push({ relation, direction: "out", label: relation.label });
    if (relation.key !== "part_of" && (relation.to === "any" || relation.to.includes(kind))) out.push({ relation, direction: "in", label: relation.inverse });
  }
  return out;
}

function AddLink({ entity, open, onClose }: { entity: BrainEntity; open: boolean; onClose: () => void }) {
  const { data: model } = useBrainModel();
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const options = relationOptions(model, entity.kind);
  const [choice, setChoice] = useState(0);
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<BrainEntitySummary | null>(null);
  const [detail, setDetail] = useState("");
  const [saving, setSaving] = useState(false);
  const option = options[choice];
  const allowed = option ? (option.direction === "out" ? option.relation.to : option.relation.from) : "any";
  const results = useQuery({
    queryKey: [...brainKeys.all(company), "link-search", q, allowed === "any" ? "" : allowed.join(",")],
    queryFn: () => api.get<BrainEntitySummary[]>(path(`/brain/search${qs({ q, kinds: allowed === "any" ? undefined : allowed.join(",") })}`)),
    enabled: q.trim().length >= 2,
  });
  const save = async () => {
    if (!option || !target) return;
    setSaving(true);
    try {
      const body = option.direction === "out" ? { from: entity.id, to: target.id } : { from: target.id, to: entity.id };
      await api.post(path("/brain/links"), { ...body, relation: option.relation.key, detail: detail.trim() || undefined });
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
      toast.success("Linked");
      onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Link ${entity.name}`}
      description="How it relates to another thing of the brain."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!target}>
            Link
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">{entity.name}…</label>
          <select
            className="input"
            value={choice}
            onChange={(e) => {
              setChoice(Number(e.target.value));
              setTarget(null);
            }}
          >
            {options.map((o, i) => (
              <option key={`${o.relation.key}-${o.direction}`} value={i}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">…what</label>
          {target ? (
            <div className="flex items-center gap-2">
              <ThingChip thing={target} model={model} />
              <button
                type="button"
                onClick={() => setTarget(null)}
                className="rounded p-1 text-faint hover:bg-subtle hover:text-fg"
                aria-label="Choose another"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <>
              <input className="input" placeholder="Type a name…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              <ul className="mt-1 max-h-56 overflow-y-auto">
                {(results.data ?? [])
                  .filter((r) => r.id !== entity.id)
                  .slice(0, 10)
                  .map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setTarget(r)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-subtle"
                      >
                        <KindIcon kind={r.kind} model={model} size="sm" />
                        <span className="truncate text-sm text-fg">{r.name}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-faint">{kindOf(model, r.kind)?.name}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>
        {option?.relation.detail && (
          <div>
            <label className="label">{option.relation.detail.label}</label>
            {option.relation.detail.choices ? (
              <select className="input" value={detail} onChange={(e) => setDetail(e.target.value)}>
                <option value="">—</option>
                {option.relation.detail.choices.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            ) : (
              <input className="input" value={detail} onChange={(e) => setDetail(e.target.value)} />
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function AddNote({ entity }: { entity: BrainEntity }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const [title, ...rest] = text.trim().split("\n");
      await api.post(path("/brain/events"), { kind: "note", title: title!.slice(0, 300), body: rest.join("\n").trim() || undefined, about: [entity.id] });
      setText("");
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="mb-4 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void save();
      }}
    >
      <input
        className="input h-9 text-[13px]"
        placeholder={`Add an update or a note about ${entity.name}…`}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button type="submit" size="sm" icon={NotebookPen} loading={saving} disabled={!text.trim()} className="h-9">
        Add
      </Button>
    </form>
  );
}

/** One thing of the brain: what it is, its values, what it links to, and what happened around it. */
export default function BrainEntityPage() {
  const { id = "" } = useParams();
  const { data: model } = useBrainModel();
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const entity = useBrainEntity(id);
  const mayEdit = useMayEditBrain();
  const lookup = useNameLookup(entity.data);
  const [editing, setEditing] = useState(false);
  const [telling, setTelling] = useState(false);
  const [linking, setLinking] = useState(false);
  const [removing, setRemoving] = useState(false);
  useDocumentTitle(entity.data?.name ?? "Company brain");

  if (entity.error) {
    return (
      <Page>
        <ErrorState error={entity.error} onRetry={() => void entity.refetch()} />
      </Page>
    );
  }
  const thing = entity.data;
  if (!thing) {
    return (
      <Page wide>
        <Skeleton className="h-24" />
        <Skeleton className="mt-6 h-96" />
      </Page>
    );
  }
  const kind = kindOf(model, thing.kind);
  const dimension = model?.dimensions.find((d) => d.key === kind?.dimension);
  const fields = (kind?.fields ?? []).filter((f) => !f.hidden && thing.data[f.key] !== undefined && thing.data[f.key] !== null && thing.data[f.key] !== "");
  const wide = new Set(["steps", "apis", "tables", "contacts", "milestones", "long_text"]);
  const sources = [...new Set([...Object.values(thing.origins), ...Object.keys(thing.refs)])];
  const groups = groupLinks(thing.links);
  const slug = typeof thing.data.slug === "string" ? thing.data.slug : null;

  const unlink = async (link: BrainLink) => {
    try {
      await api.del(path(`/brain/links/${link.id}`));
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
    } catch (error) {
      toast.error(error);
    }
  };
  const remove = async () => {
    try {
      await api.del(path(`/brain/entities/${thing.id}`));
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
      toast.success(`Removed ${thing.name}`);
      navigate(`/brain/k/${thing.kind}`);
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <Page wide>
      <div className="mb-6 space-y-4">
        <div className="flex min-w-0 items-start gap-3">
          <KindIcon kind={thing.kind} model={model} size="lg" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted">
              <Link to={`/brain/k/${thing.kind}`} className="hover:underline">
                {kind?.name}
              </Link>
              {dimension ? ` · ${dimension.name}` : ""}
            </p>
            <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{thing.name}</h1>
            {thing.summary && <p className="mt-1 max-w-3xl text-sm whitespace-pre-line text-muted">{thing.summary}</p>}
            {thing.aliases.length > 0 && <p className="mt-1 text-xs text-faint">Also called {thing.aliases.join(", ")}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
              <span>Known from</span>
              {sources.map((origin) => (
                <Badge key={origin} size="xs" tone={origin === "manual" ? "brand" : "neutral"}>
                  {originName(origin)}
                </Badge>
              ))}
              <span>· updated {timeAgo(thing.updatedAt)}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:pl-14">
          {slug && (
            <ButtonLink to={`/ai/${slug}`} icon={Bot} size="sm">
              Open AI employee
            </ButtonLink>
          )}
          <ButtonLink to={`/brain/ask?q=${encodeURIComponent(`Tell me about ${thing.name}`)}`} icon={MessageCircleQuestion} size="sm">
            Ask about it
          </ButtonLink>
          <ButtonLink to={`/brain/map?focus=${thing.id}`} icon={Share2} size="sm">
            Map
          </ButtonLink>
          <Button icon={Lightbulb} size="sm" onClick={() => setTelling(true)}>
            Tell the brain
          </Button>
          {mayEdit && (
            <>
              <Button icon={Pencil} size="sm" variant="primary" onClick={() => setEditing(true)}>
                Change
              </Button>
              <Button icon={Trash2} size="sm" variant="ghost" onClick={() => setRemoving(true)} aria-label="Remove" />
            </>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Details" subtitle={kind?.description} />
            <CardBody>
              {fields.length === 0 ? (
                <p className="text-sm text-muted">Nothing written down yet.{mayEdit ? " Use Change to add it." : ""}</p>
              ) : (
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  {fields.map((field) => {
                    const origin = thing.origins[`data.${field.key}`];
                    const value = thing.data[field.key];
                    // Lists of sentences (rules, risks) and long sentences read better across the card.
                    const long =
                      (field.type === "list" && ((value as string[]).length > 8 || (value as string[]).some((item) => item.length > 32))) ||
                      (typeof value === "string" && value.length > 60);
                    return (
                      <div key={field.key} className={wide.has(field.type) || long ? "sm:col-span-2" : ""}>
                        <dt className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted" title={origin ? `From ${originName(origin)}` : undefined}>
                          {field.label}
                          {origin === "manual" && (
                            <Badge size="xs" tone="brand">
                              edited
                            </Badge>
                          )}
                        </dt>
                        <dd>
                          <FieldValue field={field} value={thing.data[field.key]} data={thing.data} lookup={lookup} model={model} />
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Timeline" subtitle="Messages, emails, updates and changes about it" />
            <CardBody>
              <AddNote entity={thing} />
              {thing.events.length ? (
                <ul className="divide-y divide-line/70">
                  {thing.events.map((event) => (
                    <EventItem key={event.id} event={event} model={model} hide={thing.id} />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Nothing has happened around it yet.</p>
              )}
            </CardBody>
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Links"
              subtitle={`${thing.links.length} to people, systems, processes and more`}
              icon={Link2}
              actions={
                mayEdit ? (
                  <Button size="xs" variant="soft" icon={Plus} onClick={() => setLinking(true)}>
                    Link
                  </Button>
                ) : undefined
              }
            />
            <CardBody>
              {groups.length === 0 ? (
                <p className="text-sm text-muted">Not linked to anything yet.</p>
              ) : (
                <dl className="space-y-4">
                  {groups.map((group) => (
                    <div key={group.key}>
                      <dt className="mb-1.5 text-xs font-medium text-muted">
                        {group.label} <span className="text-faint">({group.links.length})</span>
                      </dt>
                      <dd className={group.links.some((l) => l.detail) ? "space-y-1" : "flex flex-wrap gap-1.5"}>
                        {group.links.map((link) => (
                          <span
                            key={link.id}
                            className={
                              link.detail || group.links.some((l) => l.detail)
                                ? "group flex max-w-full items-center gap-1.5"
                                : "group inline-flex max-w-full items-center gap-0.5"
                            }
                          >
                            <ThingChip thing={link.other} model={model} className={link.detail ? "max-w-[62%] shrink-0" : undefined} />
                            {link.detail && (
                              <span className="min-w-0 truncate text-xs text-muted" title={link.detail}>
                                {link.detail}
                              </span>
                            )}
                            {mayEdit && (
                              <button
                                type="button"
                                onClick={() => void unlink(link)}
                                className="hidden rounded-full p-0.5 text-faint group-hover:inline-flex hover:bg-subtle hover:text-red-600"
                                aria-label={`Remove the link to ${link.other.name}`}
                                title={`Remove (${originName(link.origin)})`}
                              >
                                <X className="size-3" />
                              </button>
                            )}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
      {editing && <EntityForm open onClose={() => setEditing(false)} entity={thing} />}
      <TellTheBrain open={telling} onClose={() => setTelling(false)} about={{ id: thing.id, name: thing.name }} />
      {linking && <AddLink entity={thing} open onClose={() => setLinking(false)} />}
      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Remove ${thing.name}?`}
        description={
          Object.keys(thing.refs).length || Object.values(thing.origins).some((o) => o !== "manual")
            ? "It came from a source: the brain hides it and won't bring it back on the next sync."
            : "It and its links are removed."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              Remove
            </Button>
          </>
        }
      />
    </Page>
  );
}
