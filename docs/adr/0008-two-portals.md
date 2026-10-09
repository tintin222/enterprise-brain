# ADR 0008: Two portals at one address: Operations and the Studio

**Status:** accepted · 2026-10-09

## Context
The web app had nine places in one menu that mixed two kinds of work: the daily work (Home, Chat, Work, Mail, the apps people use, what AI employees did) and designing and configuring (hiring AI employees and changing their jobs, the company brain, building apps, Settings). One page often held both: an AI employee's page showed its results next to its access, rules, coaching and versions, and a table's page had its records next to its design. The product owner asked to separate the operational part from designing AI employees and configuring the company brain, as two portals with different links, both open to everyone.

## Decision
- **One app, one address, two portals.** **Operations** stays at the root (`/`): Home, Chat, Work, Mail, Apps and Company. The **Studio** lives under `/studio`: its Home, AI employees, Brain, Apps, Ready-made and Settings. One sign-in serves both (the session cookie is for the whole site), and the server, its permissions and its API are unchanged: a worker sees the same read-only views in the Studio as before, and what they may not open says who does it.
- **The portal follows from the address** (`portalOf` in `apps/web/src/lib/paths.ts`), not from a setting or a context, and every in-app link is built there, so a link always lands in the right portal. The header's **Operations | Studio** switch opens the same thing in the other portal when it has one (an AI employee's results and its design, a table used and changed: `twin`), else the page last seen there. The Studio has its own accent (a violet line, a tinted canvas, "Studio" in the tab title) so people know where they are.
- **The brain lives in the Studio.** Its pages are `/studio/brain/…`, and links to a thing (answers, "@" chips, search) open there; asking the brain stays a conversation in Chat.
- **Things in both portals are one page with two modes.** In Operations an AI employee's page shows its overview, work and duties; in the Studio its job, duties, access, knowledge, probation and rules, coaching and versions. Tables, apps and calculations are used in Operations, with *Change it in the Studio* for those who may change them; in the Studio their design opens, with *Use it* to go back. A design tab or a `?change=` reaching Operations forwards to the Studio.
- **The Home box hands over instead of doing everything everywhere.** Work, regular work and answers belong to Operations; tables, apps, AI employees and changes to the Studio; a calculation is worked out in either and kept in the Studio. A reading of the other portal offers *Continue in the Studio* (or *in Operations*) to those who may do it, carrying the words (`?need=`, `as`, `files`); nothing runs there until the person says so.
- **Old addresses keep working.** `/brain/…`, `/hire/…`, `/settings/…` and the older ones redirect with their query and hash (`MOVED`), a Studio thread's old `/studio/<id>` opens its conversation, and links written into messages before the change are rewritten as they are shown (`upgrade`). Links the server builds (brain addresses, chips, the building inventory, the connection sign-in return) point at the new pages; a document chip opens it beside the search results (`/search?doc=<id>`), which everyone who may read it can open.

## Consequences
- People doing the daily work see six places and none of the configuration; people designing see the Studio's six; each page has one purpose.
- No server change, migration or second build: one bundle, one deployment, the same API.
- A link built by hand can still point at an old address; it keeps working through the redirects, and `paths.ts` is where new links come from.
- Screenshots taken before the change show the old menu until they are taken again.
