// Connector SDK contract
export * from "./types.ts";
export {
  defineConnector,
  defineManifest,
  type ConfigFieldInput,
  type ConnectorDefinition,
  type ConnectorManifestInput,
  type OperationHandler,
} from "./define.ts";
export * as schema from "./schema.ts";

// Registry, tools and validation
export { BUILTIN_CONNECTORS, ConnectorRegistry, createDefaultRegistry, sandboxConnectorFor } from "./registry.ts";
export { operationToolName, validateOperationInput } from "./tools.ts";

// HTTP, OAuth 2.0 and OData helpers for connector authors
export * from "./http.ts";

// Sandbox systems
export { InMemorySandboxStore } from "./sandbox/store.ts";
export { defineSandboxConnector, SandboxDb, type SandboxDefinition, type SandboxHandler } from "./sandbox/common.ts";
export { sandboxErpConnector } from "./sandbox/erp.ts";
export { sandboxCrmConnector } from "./sandbox/crm.ts";
export { sandboxHrisConnector } from "./sandbox/hris.ts";
export { sandboxAtsConnector } from "./sandbox/ats.ts";
export { sandboxItsmConnector } from "./sandbox/itsm.ts";

// Connectors for real systems
export { sapS4hanaConnector } from "./connectors/sap-s4hana.ts";
export { dynamics365Connector } from "./connectors/dynamics-365.ts";
export { salesforceConnector, soqlString } from "./connectors/salesforce.ts";
export { hubspotConnector } from "./connectors/hubspot.ts";
export { microsoft365MailConnector } from "./connectors/microsoft-365-mail.ts";
export {
  createImapSmtpConnector,
  imapSmtpConnector,
  type ImapClientLike,
  type ImapSmtpDeps,
  type SmtpMail,
  type SmtpTransportLike,
} from "./connectors/imap-smtp.ts";
export { gmailConnector } from "./connectors/gmail.ts";
export { sharepointConnector } from "./connectors/sharepoint.ts";
export { successFactorsConnector } from "./connectors/sap-successfactors.ts";
export { workdayConnector } from "./connectors/workday.ts";
export { resolveRestUrl, restApiConnector } from "./connectors/rest-api.ts";
export {
  createSqlDatabaseConnector,
  DEFAULT_MAX_ROWS,
  guardReadOnlySql,
  limitQuery,
  sqlDatabaseConnector,
  type SqlClient,
  type SqlClientConfig,
  type SqlDatabaseDeps,
  type SqlQueryResult,
} from "./connectors/sql-database.ts";
export { signWebhookPayload, SUBMISSION_EVENT, verifyWebhookSignature, webhookInboundConnector } from "./connectors/webhook-inbound.ts";
