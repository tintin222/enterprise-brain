import { generatePath, matchPath, useLocation } from "react-router";

/**
 * The two portals at one address: Operations (the daily work, at the root) and the Studio (designing AI
 * employees, the company brain, building and configuration, under /studio). Which one a page belongs to
 * follows from its address; these builders keep every link in the right one.
 */
export type Portal = "operations" | "studio";

export const STUDIO = "/studio";

export function portalOf(pathname: string): Portal {
  return pathname === STUDIO || pathname.startsWith(`${STUDIO}/`) ? "studio" : "operations";
}

/** The portal of the page being shown. */
export function usePortal(): Portal {
  return portalOf(useLocation().pathname);
}

type Query = Record<string, string | number | boolean | null | undefined>;

function withQuery(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

const at = (portal: Portal, path: string) => (portal === "studio" ? `${STUDIO}${path}` : path);
const part = encodeURIComponent;

export const paths = {
  /** Each portal's home. */
  home: (portal: Portal = "operations") => (portal === "studio" ? STUDIO : "/"),

  // Operations
  chat: () => "/chat",
  conversation: (id: string, query?: Query) => withQuery(`/chat/${part(id)}`, query),
  /** A channel or direct message with the thread under one of its messages open. */
  thread: (parentId: string, rootId: string) => `/chat/${part(parentId)}?thread=${part(rootId)}`,
  threads: () => "/chat/threads",
  companyBrainChat: (query?: Query) => withQuery("/chat/for/ai_employee/company-brain", query),
  aiChat: (slug: string, query?: Query) => withQuery(`/chat/for/ai_employee/${part(slug)}`, query),
  /** The viewer's direct message with a person. */
  dm: (personId: string, query?: Query) => withQuery(`/chat/for/dm/${part(personId)}`, query),
  thingChat: (id: string, query?: Query) => withQuery(`/chat/for/thing/${part(id)}`, query),
  work: (ref?: string, query?: Query) => withQuery(ref ? `/work/${part(ref)}` : "/work", query),
  mail: (query?: Query) => withQuery("/mail", query),
  company: (hash?: string) => `/company${hash ? `#${hash}` : ""}`,
  performance: (query?: Query) => withQuery("/company/performance", query),
  aiScreen: (slug: string) => `/ai/${part(slug)}/app`,
  run: (id: string) => `/runs/${part(id)}`,

  // Studio
  brain: {
    home: () => `${STUDIO}/brain`,
    kind: (kind: string) => `${STUDIO}/brain/k/${part(kind)}`,
    thing: (id: string) => `${STUDIO}/brain/e/${part(id)}`,
    map: (focus?: string) => withQuery(`${STUDIO}/brain/map`, { focus }),
    sources: () => `${STUDIO}/brain/sources`,
  },
  aiEmployees: () => `${STUDIO}/ai`,
  readyMade: (id?: string, query?: Query) => withQuery(id ? `${STUDIO}/ready-made/${part(id)}` : `${STUDIO}/ready-made`, query),
  studioConversation: (id: string) => `${STUDIO}/conversations/${part(id)}`,
  interview: (id: string, query?: Query) => withQuery(`${STUDIO}/interviews/${part(id)}`, query),
  settings: (section?: string, query?: Query) => withQuery(section ? `${STUDIO}/settings/${part(section)}` : `${STUDIO}/settings`, query),

  // In both: the same thing, used in Operations, designed in the Studio
  ai: (slug: string, portal: Portal, tab?: string) => withQuery(at(portal, `/ai/${part(slug)}`), { tab }),
  apps: (portal: Portal) => at(portal, "/apps"),
  table: (key: string, portal: Portal, query?: Query) => withQuery(at(portal, `/tables/${part(key)}`), query),
  app: (key: string, portal: Portal, query?: Query) => withQuery(at(portal, `/apps/${part(key)}`), query),
  calculation: (key: string, portal: Portal, query?: Query) => withQuery(at(portal, `/calculations/${part(key)}`), query),
  search: (portal: Portal, query?: Query) => withQuery(at(portal, "/search"), query),
  /** A portal's home with words to read in its box ("Continue in the Studio" from the other one). */
  need: (portal: Portal, need: { text: string; as?: string; files?: string[] }) =>
    withQuery(paths.home(portal), { need: need.text, as: need.as, files: need.files?.length ? need.files.join(",") : undefined }),
};

/**
 * Old addresses → where they live now, the most specific first. ":name" and a final "*" carry over; the
 * query and hash are kept. Links in emails, old messages and bookmarks keep working through these.
 */
export const MOVED: [from: string, to: string][] = [
  ["brain/ask", "/chat/for/ai_employee/company-brain"],
  ["brain/*", `${STUDIO}/brain/*`],
  ["hire", STUDIO],
  ["hire/studio/new", `${STUDIO}/interviews/new`],
  ["hire/studio/:id", `${STUDIO}/interviews/:id`],
  ["hire/ready-made", `${STUDIO}/ready-made`],
  ["hire/ready-made/:id", `${STUDIO}/ready-made/:id`],
  ["settings/mailboxes", "/mail"],
  ["settings/*", `${STUDIO}/settings/*`],
  ["agents", "/company"],
  ["agents/:slug", "/ai/:slug"],
  ["departments", "/company"],
  ["builder", STUDIO],
  ["builder/new", `${STUDIO}/interviews/new`],
  ["builder/:id", `${STUDIO}/interviews/:id`],
  ["catalog", `${STUDIO}/ready-made`],
  ["catalog/departments/:id", `${STUDIO}/ready-made/:id`],
  ["approvals", "/work"],
  ["runs", "/work?view=tasks"],
  ["connectors", `${STUDIO}/settings/connections`],
  ["knowledge", `${STUDIO}/settings/knowledge`],
  ["people", `${STUDIO}/settings/people`],
  ["inbox", "/mail"],
  ["activity", `${STUDIO}/settings/audit`],
  ["paperclip", `${STUDIO}/settings/paperclip`],
  ["assistant", "/chat"],
];

/** Where `to` (a MOVED target) sends this address: its parameters filled in, its query merged with `search`. */
export function movedTo(to: string, params: Record<string, string | undefined>, search = "", hash = ""): string {
  const [path = "/", query = ""] = to.split("?");
  const merged = new URLSearchParams(query);
  new URLSearchParams(search).forEach((value, key) => merged.set(key, value));
  const rest = merged.toString();
  return `${generatePath(path, params)}${rest ? `?${rest}` : ""}${hash ? (hash.startsWith("#") ? hash : `#${hash}`) : ""}`;
}

/** An old in-app link written before the portals (in a message, an answer): where it lives now. */
export function upgrade(href: string): string {
  if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/")) return href;
  const hashAt = href.indexOf("#");
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const pathname = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const search = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
  for (const [from, to] of MOVED) {
    const match = matchPath({ path: `/${from}`, end: true }, pathname);
    if (match) return movedTo(to, match.params, search, hash);
  }
  return href;
}

/** Pages that exist in both portals: an AI employee's results and its design, a table used and designed… */
const TWINS: [operations: string, studio: string][] = [
  ["/ai/:slug", `${STUDIO}/ai/:slug`],
  ["/ai/:slug/app", `${STUDIO}/ai/:slug`],
  ["/company", `${STUDIO}/ai`],
  ["/apps", `${STUDIO}/apps`],
  ["/apps/:key", `${STUDIO}/apps/:key`],
  ["/tables/:key", `${STUDIO}/tables/:key`],
  ["/calculations/:key", `${STUDIO}/calculations/:key`],
  ["/search", `${STUDIO}/search`],
];

/** The same page in the other portal, when it has one. */
export function twin(pathname: string): string | null {
  for (const [operations, studio] of TWINS) {
    const fromOperations = matchPath({ path: operations, end: true }, pathname);
    if (fromOperations) return generatePath(studio, fromOperations.params);
    const fromStudio = matchPath({ path: studio, end: true }, pathname);
    if (fromStudio) return generatePath(operations, fromStudio.params);
  }
  return null;
}
