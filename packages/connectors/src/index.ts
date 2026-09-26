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
export { sandboxCalendarConnector, usualBusy } from "./sandbox/calendar.ts";

// Connectors for real systems
export { sapS4hanaConnector } from "./connectors/sap-s4hana.ts";
export { dynamics365Connector } from "./connectors/dynamics-365.ts";
export { salesforceConnector, soqlString } from "./connectors/salesforce.ts";
export { hubspotConnector } from "./connectors/hubspot.ts";
export { microsoft365MailConnector } from "./connectors/microsoft-365-mail.ts";
export {
  BOT_FRAMEWORK_SCOPE,
  botToken,
  checkServiceUrl,
  getMember,
  microsoftTeamsConnector,
  sendActivity,
  teamsBotSettings,
  updateActivity,
  type TeamsAddress,
  type TeamsBotSettings,
  type TeamsMember,
} from "./connectors/microsoft-teams.ts";
export {
  createImapSmtpConnector,
  imapSmtpConnector,
  type ImapClientLike,
  type ImapSmtpDeps,
  type SmtpMail,
  type SmtpTransportLike,
} from "./connectors/imap-smtp.ts";
export { gmailConnector } from "./connectors/gmail.ts";
export { CALENDAR_SCOPE, googleCalendarConnector } from "./connectors/google-calendar.ts";
export { microsoft365CalendarConnector } from "./connectors/microsoft-365-calendar.ts";
export {
  CALENDAR_OPERATIONS,
  DEFAULT_TIME_ZONE,
  freeSlots,
  isoInZone,
  mergeIntervals,
  slotLabel,
  zonedInstant,
  zoneOffsetMinutes,
  type Interval,
} from "./connectors/calendar-common.ts";
export {
  CHAT_API,
  CHAT_BOT_SCOPE,
  chatToken,
  createChatMessage,
  googleChatConnector,
  googleChatSettings,
  updateChatMessage,
  type GoogleChatSettings,
} from "./connectors/google-chat.ts";
export { sharepointConnector } from "./connectors/sharepoint.ts";
export { successFactorsConnector } from "./connectors/sap-successfactors.ts";
export { workdayConnector } from "./connectors/workday.ts";
export { resolveRestUrl, restApiConnector } from "./connectors/rest-api.ts";
export {
  bindNamedParams,
  createSqlDatabaseConnector,
  DEFAULT_MAX_ROWS,
  guardReadOnlySql,
  limitQuery,
  sqlDatabaseConnector,
  type SqlClient,
  type SqlClientConfig,
  type SqlDatabaseDeps,
  type SqlDialect,
  type SqlQueryResult,
} from "./connectors/sql-database.ts";
export { signWebhookPayload, SUBMISSION_EVENT, verifyWebhookSignature, webhookInboundConnector } from "./connectors/webhook-inbound.ts";

// Named actions: IT's own actions on web services and databases
export { actionsFromExamples, actionsFromOpenApi, checkParams, compareCursor, fillPath, fillTemplate, pollAction, rowsOf, toOperation, withNamedActions, type ProposedActions } from "./named-actions.ts";
