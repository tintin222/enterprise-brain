import type { SourceBatch } from "../types.ts";

/** What the brain reads from the platform it lives in. The runtime gives these. */
export interface PlatformDepartment {
  id: string;
  key: string;
  name: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface PlatformPerson {
  id: string;
  name: string;
  email: string;
  title: string | null;
  status: string;
  departments: { departmentId: string; role: string }[];
}

export interface PlatformAgent {
  id: string;
  slug: string;
  name: string;
  summary: string;
  status: string;
  templateId: string | null;
  departmentId: string | null;
  processId: string | null;
  managerUserId: string | null;
  probation: string;
  definition: Record<string, unknown>;
}

export interface PlatformProcess {
  id: string;
  key: string;
  name: string;
  summary: string;
  departmentId: string | null;
  data: Record<string, unknown>;
}

export interface PlatformTask {
  id: string;
  ref: string;
  title: string;
  status: string;
  agentId: string | null;
  updatedAt: Date;
}

export interface PlatformMail {
  id: string;
  mailbox: string;
  from: string;
  fromName: string | null;
  subject: string;
  body: string;
  receivedAt: Date;
}

export interface BrainSourceDeps {
  company(companyId: string): Promise<{ name: string; mailDomain: string }>;
  departments(companyId: string): Promise<PlatformDepartment[]>;
  people(companyId: string): Promise<PlatformPerson[]>;
  agents(companyId: string): Promise<PlatformAgent[]>;
  processes(companyId: string): Promise<PlatformProcess[]>;
  /** Tasks AI employees worked on since a moment. */
  tasks(companyId: string, since: Date): Promise<PlatformTask[]>;
  /** The newest emails of the shared mailboxes. */
  mail(companyId: string, limit: number): Promise<PlatformMail[]>;
  /** Records of a demo system (sandbox-crm, sandbox-erp, sandbox-itsm), written on first use. */
  sandbox(companyId: string, system: string, entity: string): Promise<Record<string, unknown>[]>;
  /** The platform's connections, to say which systems AI employees can reach. */
  connections(companyId: string): Promise<{ id: string; type: string; name: string; category: string }[]>;
}

export interface SourceContext {
  companyId: string;
  companyName: string;
  /** The company's email domain: demo people's addresses use it. */
  domain: string;
  deps: BrainSourceDeps;
  /** How many times the source was read before: demo sources bring news on each reading. */
  syncs: number;
  now: Date;
}

export interface BrainSourceDefinition {
  key: string;
  name: string;
  /** The real system it stands in for. */
  system: string;
  description: string;
  /** What it brings, in a few words each. */
  brings: string[];
  /** A lucide icon name. */
  icon: string;
  /** Made-up data standing in for the real system. */
  demo: boolean;
  /** Whose values win when two sources know the same field (people's own edits always win). */
  priority: number;
  read(ctx: SourceContext): Promise<SourceBatch>;
}
