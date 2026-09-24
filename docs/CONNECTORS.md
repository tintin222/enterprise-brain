# Connectors

Connectors link agents to the company's systems: ERP, CRM, HR, mail, document libraries and databases. Agents never talk to a system directly. They use the operations a connector declares, and the platform handles credentials, validation, approvals and the audit log.

```text
agent definition            connectors: [{ ref: erp, category: erp }]
      │
      ▼  binding resolution (per company)
explicit instance  →  first configured connector of the category  →  built-in sandbox system
      │
      ▼
operation  erp.get_purchase_order (read)       runs immediately
operation  erp.post_supplier_invoice (write)   waits for human approval (guardrails)
```

## Built-in connectors

| Type | System | Category | Operations | Maturity |
|---|---|---|---|---|
| `sandbox-erp` | Sandbox ERP (suppliers, POs, goods receipts, invoices, customers, stock, G/L) | erp · accounting · scm | 11 read, 4 write | sandbox |
| `sandbox-crm` | Sandbox CRM (accounts, contacts, leads, cases, opportunities) | crm | 7 read, 6 write | sandbox |
| `sandbox-hris` | Sandbox HRIS (employees, leave, positions) | hris | 5 read, 3 write | sandbox |
| `sandbox-ats` | Sandbox ATS (requisitions, candidates, interviews) | ats | 4 read, 3 write | sandbox |
| `sandbox-itsm` | Sandbox ITSM (tickets, assets, access requests) | itsm | 3 read, 3 write | sandbox |
| `sap-s4hana` | SAP S/4HANA (Cloud and on-premise, OData v2) | erp | business partners, purchase orders, supplier invoices, sales orders | preview |
| `microsoft-dynamics-365` | Microsoft Dynamics 365 / Dataverse (Web API) | crm | query, get, create, update records | preview |
| `salesforce` | Salesforce (REST API, SOQL) | crm | SOQL query, get/create/update records, contacts by email | preview |
| `hubspot` | HubSpot CRM (CRM v3) | crm | search, get, create, update objects | preview |
| `microsoft-365-mail` | Microsoft 365 mail via Microsoft Graph | mail | list, get, attachments, send, reply, move; `new_message` event | preview |
| `gmail` | Gmail / Google Workspace (Gmail API) | mail | list, get, attachments, send; `new_message` event | preview |
| `imap-smtp` | Any IMAP/SMTP mailbox | mail | list, get, attachments, send; `new_message` event | preview |
| `sharepoint` | SharePoint / OneDrive document libraries (Graph) | dms | list, download, search, upload files | preview |
| `sap-successfactors` | SAP SuccessFactors Employee Central (OData v2) | hris | search/get users, employment | preview |
| `workday` | Workday HCM (REST) | hris | search/get workers, direct reports | preview |
| `rest-api` | Any REST API (API key, bearer, basic) | other | GET, POST, PUT, PATCH, DELETE | preview |
| `sql-database` | PostgreSQL, read-only | database | run query (guarded), list tables, describe table | preview |
| `webhook-inbound` | Web forms and system webhooks (HMAC-signed) | web | `submission` event | stable |

**Maturity**

- **sandbox**: built-in demo systems with realistic data (Acme Endüstri A.Ş., a pumps and valves manufacturer). They are stored in the platform database, so writes persist and later reads see them. Every template works on day one because each category falls back to its sandbox.
- **preview**: implemented from the vendor's API documentation and tested against recorded request/response contracts, but not yet against live tenants. Verify each one in the customer's environment before production use.
- **stable**: proven end to end.

## Bindings: how agents find their systems

Agents declare what they need by **category**, not by vendor:

```yaml
connectors:
  - { ref: erp, category: erp, purpose: Purchase orders and supplier invoices }
```

At run time the platform resolves each binding in this order:

1. the instance pinned in the binding (`instanceId`)
2. otherwise the company's first configured connector of that category (for example SAP S/4HANA)
3. otherwise the built-in sandbox system of the category

The same agent therefore runs against the sandbox during design and testing, and against SAP once IT has configured it, with no change to the agent. Runs record which system served each call.

## Operations, tools and approvals

Each operation has an id, a **kind** (`read` or `write`) and a JSON Schema for its input. Inputs are validated before the connector code runs.

- **Workflows** call operations with `connector` steps: `{ type: connector, connector: erp, operation: get_purchase_order, input: { po_number: "{{ steps.fields.po_number }}" } }`.
- **Autonomous steps and chat** get them as Claude tools named `<ref>__<operation>`, for example `erp__get_purchase_order`. An agent's capabilities pick which ones: `connector:erp` means every operation, `connector:erp.get_purchase_order` means one.
- **Paperclip and other MCP clients** reach the read operations through the MCP server at `/mcp`.

**Write operations wait for a human** when the agent's guardrails list `connector:write`, which is the default. The run pauses, or a chat creates a deferred action, and the approval appears in *Approvals* with the exact input. It executes only after someone approves. Test runs never execute writes; they record what *would* have been done.

## Credentials

Connector configuration is entered in *Connectors* (or `POST /api/companies/:company/connectors`).

- Fields marked `secret` in the manifest (passwords, client secrets, tokens, private keys) are encrypted with AES-256-GCM, using `EB_MASTER_KEY` or a generated key file in the data directory. They are never returned by the API.
- *Test connection* calls the connector's `test()`, which makes a harmless read against the real system.
- OAuth tokens (client credentials and refresh token flows) are cached in memory until shortly before they expire.

## What IT needs to provide

Every manifest lists its `itRequirements`: app registrations, permission scopes, technical users, firewall rules and so on. When the Agent Builder finds that an agent needs a system that isn't connected yet, it drafts the request to IT from these lists. For example, the request for Microsoft 365 mail covers the Entra ID app, the `Mail.ReadWrite`/`Mail.Send` application permissions and scoping the app to one mailbox. The IT director answers through a link and the analyst folds the answer back into the design. The same lists appear on each connector's setup page.

## Writing a connector

A connector is a manifest plus one handler per operation:

```ts
import { defineConnector, defineManifest, httpRequest, schema } from "@enterprise-brain/connectors";

const manifest = defineManifest({
  type: "acme-wms",
  name: "Acme Warehouse",
  vendor: "Acme",
  category: "scm",
  description: "Stock levels and shipments from the warehouse management system.",
  auth: "bearer",
  maturity: "preview",
  config: [
    { key: "base_url", label: "API base URL", type: "url", required: true },
    { key: "token", label: "API token", type: "password", required: true, secret: true },
  ],
  operations: [
    schema.readOp("get_stock", "Get stock", "Stock of one item in all warehouses.", { sku: schema.str("Item number") }, ["sku"]),
    schema.writeOp("create_shipment", "Create shipment", "Book an outbound shipment.", {
      order_number: schema.str("Sales order number"),
    }, ["order_number"]),
  ],
  itRequirements: ["An API token with read access to stock and write access to shipments", "HTTPS access from Enterprise Brain to the WMS API"],
});

export const acmeWmsConnector = defineConnector({
  manifest,
  async test(ctx) {
    await httpRequest(ctx.fetch, `${ctx.config.base_url}/health`, { service: "Acme WMS", headers: { authorization: `Bearer ${ctx.secrets.token}` } });
    return { ok: true, message: "Connected to Acme Warehouse." };
  },
  operations: {
    async get_stock(input, ctx) {
      const res = await httpRequest(ctx.fetch, `${ctx.config.base_url}/stock/${encodeURIComponent(String(input.sku))}`, {
        service: "Acme WMS",
        headers: { authorization: `Bearer ${ctx.secrets.token}` },
      });
      return res.data;
    },
    async create_shipment(input, ctx) {
      const res = await httpRequest(ctx.fetch, `${ctx.config.base_url}/shipments`, {
        method: "POST",
        json: input,
        service: "Acme WMS",
        headers: { authorization: `Bearer ${ctx.secrets.token}` },
      });
      return res.data;
    },
  },
});
```

Register it in `createDefaultRegistry()` (`packages/connectors/src/registry.ts`).

- `defineConnector` checks that every declared operation has a handler and vice versa, validates inputs against the operation schemas, and turns exceptions in `test()` into `{ ok: false }`.
- Throw a `ConnectorError` with a code (`config`, `auth`, `not_found`, `validation`, `remote` or `unsupported`) so that agents and people get an actionable message.
- `httpRequest` maps HTTP failures to `ConnectorError`s with the vendor's error text.
- `packages/connectors/src/http.ts` also has OAuth 2.0 token helpers (client credentials, refresh token, cached and retried) and OData v2/v4 helpers.
- Test connectors with an injected `fetch` that asserts the outgoing request and returns a recorded response. See `packages/connectors/test` for examples.
