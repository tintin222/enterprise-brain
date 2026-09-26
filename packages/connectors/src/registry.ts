import { ConnectorManifest, type SystemCategory } from "@enterprise-brain/core";
import { dynamics365Connector } from "./connectors/dynamics-365.ts";
import { gmailConnector } from "./connectors/gmail.ts";
import { googleCalendarConnector } from "./connectors/google-calendar.ts";
import { googleChatConnector } from "./connectors/google-chat.ts";
import { hubspotConnector } from "./connectors/hubspot.ts";
import { imapSmtpConnector } from "./connectors/imap-smtp.ts";
import { microsoft365CalendarConnector } from "./connectors/microsoft-365-calendar.ts";
import { mcpServerConnector } from "./connectors/mcp-server.ts";
import { microsoft365MailConnector } from "./connectors/microsoft-365-mail.ts";
import { microsoftTeamsConnector } from "./connectors/microsoft-teams.ts";
import { restApiConnector } from "./connectors/rest-api.ts";
import { salesforceConnector } from "./connectors/salesforce.ts";
import { sapS4hanaConnector } from "./connectors/sap-s4hana.ts";
import { successFactorsConnector } from "./connectors/sap-successfactors.ts";
import { sharepointConnector } from "./connectors/sharepoint.ts";
import { sqlDatabaseConnector } from "./connectors/sql-database.ts";
import { webhookInboundConnector } from "./connectors/webhook-inbound.ts";
import { workdayConnector } from "./connectors/workday.ts";
import { sandboxAtsConnector } from "./sandbox/ats.ts";
import { sandboxCalendarConnector } from "./sandbox/calendar.ts";
import { sandboxCrmConnector } from "./sandbox/crm.ts";
import { sandboxErpConnector } from "./sandbox/erp.ts";
import { sandboxHrisConnector } from "./sandbox/hris.ts";
import { sandboxItsmConnector } from "./sandbox/itsm.ts";
import { ConnectorError, type ConnectorImplementation } from "./types.ts";

/** Registry of connector implementations by type. */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorImplementation>();

  /** Registers an implementation; its manifest is validated and the type must be unique. */
  register(implementation: ConnectorImplementation): this {
    const manifest = ConnectorManifest.parse(implementation.manifest);
    if (this.connectors.has(manifest.type)) throw new Error(`Connector type "${manifest.type}" is already registered`);
    const ids = manifest.operations.map((op) => op.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new Error(`Connector ${manifest.type} declares operation "${duplicate}" twice`);
    this.connectors.set(manifest.type, implementation);
    return this;
  }

  get(type: string): ConnectorImplementation | undefined {
    return this.connectors.get(type);
  }

  /** Like get(), but throws a ConnectorError("config") for unknown types. */
  require(type: string): ConnectorImplementation {
    const implementation = this.connectors.get(type);
    if (!implementation) throw new ConnectorError(`Unknown connector type "${type}"`, "config");
    return implementation;
  }

  has(type: string): boolean {
    return this.connectors.has(type);
  }

  /** Manifests of all registered connectors, in registration order. */
  list(): ConnectorManifest[] {
    return [...this.connectors.values()].map((c) => c.manifest);
  }

  listByCategory(category: SystemCategory): ConnectorManifest[] {
    return this.list().filter((m) => m.category === category);
  }
}

/** Every connector shipped with Enterprise Brain: the sandbox systems first, then the real systems. */
export const BUILTIN_CONNECTORS: readonly ConnectorImplementation[] = [
  sandboxErpConnector,
  sandboxCrmConnector,
  sandboxHrisConnector,
  sandboxAtsConnector,
  sandboxItsmConnector,
  sandboxCalendarConnector,
  sapS4hanaConnector,
  dynamics365Connector,
  salesforceConnector,
  hubspotConnector,
  microsoft365MailConnector,
  imapSmtpConnector,
  gmailConnector,
  sharepointConnector,
  successFactorsConnector,
  workdayConnector,
  restApiConnector,
  sqlDatabaseConnector,
  mcpServerConnector,
  webhookInboundConnector,
  microsoftTeamsConnector,
  googleChatConnector,
  microsoft365CalendarConnector,
  googleCalendarConnector,
];

export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  for (const connector of BUILTIN_CONNECTORS) registry.register(connector);
  return registry;
}

const SANDBOX_BY_CATEGORY = new Map<string, string>([
  ["erp", "sandbox-erp"],
  ["accounting", "sandbox-erp"],
  ["scm", "sandbox-erp"],
  ["crm", "sandbox-crm"],
  ["hris", "sandbox-hris"],
  ["ats", "sandbox-ats"],
  ["itsm", "sandbox-itsm"],
  ["calendar", "sandbox-calendar"],
]);

/** The built-in sandbox connector type that stands in for a system category (so templates work without credentials). */
export function sandboxConnectorFor(category: SystemCategory | string): string | undefined {
  return SANDBOX_BY_CATEGORY.get(category);
}
