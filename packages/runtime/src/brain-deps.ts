import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import type { BrainSourceDeps } from "@enterprise-brain/brain";
import { companies, mailMessages, tasks, type DatabaseHandle } from "@enterprise-brain/db";
import type { AgentService } from "./agents.ts";
import type { CatalogService } from "./catalog-service.ts";
import { DbSandboxStore, type ConnectorService } from "./connectors.ts";
import type { PeopleService } from "./people.ts";

/** A cheap operation of each demo system: running it writes the system's demo data the first time. */
const SEED_WITH: Record<string, string> = {
  "sandbox-crm": "search_accounts",
  "sandbox-erp": "search_suppliers",
  "sandbox-itsm": "search_tickets",
  "sandbox-hris": "search_employees",
};

/** What the company brain's sources read from the platform. */
export function brainSourceDeps(services: {
  handle: DatabaseHandle;
  catalog: CatalogService;
  people: PeopleService;
  agents: AgentService;
  connectors: ConnectorService;
}): BrainSourceDeps {
  const { handle, catalog, people, agents, connectors } = services;
  return {
    async company(companyId) {
      const [row] = await handle.db.select().from(companies).where(eq(companies.id, companyId));
      const domain = row?.settings.mailDomain;
      return { name: row?.name ?? "The company", mailDomain: typeof domain === "string" && domain ? domain : "example.com" };
    },
    async departments(companyId) {
      return (await catalog.departments(companyId)).map((d) => ({ id: d.id, key: d.key, name: d.name, summary: d.summary, data: d.data }));
    },
    async people(companyId) {
      return (await people.list(companyId)).map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        title: p.title,
        status: p.status,
        departments: p.departments.map((d) => ({ departmentId: d.departmentId, role: d.role })),
      }));
    },
    async agents(companyId) {
      return (await agents.list(companyId)).map(({ row, definition }) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        summary: row.summary,
        status: row.status,
        templateId: row.templateId,
        departmentId: row.departmentId,
        processId: row.processId,
        managerUserId: row.managerUserId,
        probation: row.probation,
        definition: definition as unknown as Record<string, unknown>,
      }));
    },
    async processes(companyId) {
      return (await catalog.processes(companyId)).map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        summary: p.summary,
        departmentId: p.departmentId,
        data: p.data,
      }));
    },
    async tasks(companyId, since) {
      const rows = await handle.db
        .select({ id: tasks.id, ref: tasks.ref, title: tasks.title, status: tasks.status, agentId: tasks.agentId, updatedAt: tasks.updatedAt })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), gte(tasks.updatedAt, since)))
        .orderBy(desc(tasks.updatedAt))
        .limit(200);
      return rows;
    },
    async mail(companyId, limit) {
      const rows = await handle.db
        .select()
        .from(mailMessages)
        .where(and(eq(mailMessages.companyId, companyId), eq(mailMessages.direction, "inbound"), isNotNull(mailMessages.fromAddress)))
        .orderBy(desc(mailMessages.receivedAt))
        .limit(limit);
      return rows.map((m) => ({
        id: m.id,
        mailbox: m.mailbox,
        from: m.fromAddress,
        fromName: m.fromName,
        subject: m.subject,
        body: m.bodyText,
        receivedAt: m.receivedAt,
      }));
    },
    async sandbox(companyId, system, entity) {
      const store = new DbSandboxStore(handle, companyId);
      if ((await store.count(system)) === 0 && SEED_WITH[system]) await connectors.executeByType(companyId, system, SEED_WITH[system]!, {});
      return store.list(system, entity);
    },
    async connections(companyId) {
      return (await connectors.list(companyId)).filter((c) => !c.sandbox).map((c) => ({ id: c.id, type: c.type, name: c.name, category: c.category }));
    },
  };
}
