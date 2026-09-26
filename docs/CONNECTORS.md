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
| `sandbox-calendar` | Sandbox Calendar (everyone's usual meetings; meetings booked in it count as busy) | calendar | find free times, list events; book, cancel meetings | sandbox |
| `sap-s4hana` | SAP S/4HANA (Cloud and on-premise, OData v2) | erp | business partners, purchase orders, supplier invoices, sales orders | preview |
| `microsoft-dynamics-365` | Microsoft Dynamics 365 / Dataverse (Web API) | crm | query, get, create, update records | preview |
| `salesforce` | Salesforce (REST API, SOQL) | crm | SOQL query, get/create/update records, contacts by email | preview |
| `hubspot` | HubSpot CRM (CRM v3) | crm | search, get, create, update objects | preview |
| `microsoft-365-mail` | Microsoft 365 mail via Microsoft Graph | mail | list, get, attachments, send, reply, move; `new_message` event | preview |
| `gmail` | Gmail / Google Workspace (Gmail API) | mail | list, get, attachments, send; `new_message` event | preview |
| `imap-smtp` | Any IMAP/SMTP mailbox | mail | list, get, attachments, send; `new_message` event | preview |
| `microsoft-365-calendar` | Outlook calendars via Microsoft Graph (free/busy with `getSchedule`) | calendar | find free times, list events; book meetings with a Teams link, cancel | preview |
| `google-calendar` | Google Calendar (free/busy; service account with domain-wide delegation) | calendar | find free times, list events; book meetings with a Meet link, cancel | preview |
| `microsoft-teams` | Microsoft Teams through your Azure Bot | messaging | where people meet AI employees: see Settings → Teams and Chat | preview |
| `google-chat` | Google Chat through your Chat app | messaging | where people meet AI employees: see Settings → Teams and Chat | preview |
| `sharepoint` | SharePoint / OneDrive document libraries (Graph) | dms | list, download, search, upload files | preview |
| `sftp` | Any SFTP server (SSH key or password; the host key is always checked) | storage | list, read, write, move files; `new_file` event | preview |
| `shared-folder` | A network drive mounted on the Enterprise Brain server (SMB, NFS) | storage | list, read, write, move files; `new_file` event | stable |
| `sap-successfactors` | SAP SuccessFactors Employee Central (OData v2) | hris | search/get users, employment | preview |
| `workday` | Workday HCM (REST) | hris | search/get workers, direct reports | preview |
| `rest-api` | Any REST API (API key, bearer, basic, OAuth 2.0, client certificates) | other | GET, POST, PUT, PATCH, DELETE | preview |
| `sql-database` | PostgreSQL, read-only | database | run query (guarded), list tables, describe table | preview |
| `mcp-server` | Any MCP server over Streamable HTTP (bearer, API key header, OAuth 2.0 client credentials, client certificates) | other | its tools, imported as named actions | preview |
| `webhook-inbound` | Web forms and system webhooks (HMAC-signed) | web | `submission` event | stable |

**MCP servers** are connected by their URL (the Streamable HTTP transport, protocol 2025-06-18 or 2025-03-26). *Actions → Import the server's tools* proposes one action per tool: read when the tool says it only reads (`readOnlyHint`), otherwise write, and asking a person every time when the tool says it is destructive. Each action keeps the tool's own input schema, so AI employees fill it in as the server describes it; IT renames them, marks them, tries them and saves, as for web services. The client initializes once per call, keeps the session id the server gives, starts again when the server forgets it, reads answers sent as JSON or as an event stream, and ends the session afterwards.

**Files: SFTP servers and shared folders** work alike. Every path is inside the connection's folder: `/incoming/INV-1.pdf` and `incoming\INV-1.pdf` mean the same file, and `..` is refused. `list_files` lists a folder (files newest first, by name patterns such as `*.pdf; *.xml`, into subfolders when asked); `read_file` brings a file into Enterprise Brain and returns its file id, which the document and Excel tools read, plus the text of small text files (CSV, XML, TXT up to 200 KB); `write_file` writes text, base64 or a stored file (`file_id`: an attachment, an upload, a generated report) under a temporary name first and then renames it, so nobody picks up half a file, creates missing folders, and replaces an existing file only with `overwrite`; `move_file` moves a file, into a folder under its own name when `to` ends with `/`. Files are never deleted. Writes and moves are write operations: a person approves them at Shadow and Supervised.

A connection can be **watched**: each new file in its *Watched folder* that matches *Files to pick up* starts the duties of AI employees that watch it (`{ type: connector-event, connector: <ref>, event: new_file }`). The file is brought in once and handed over as the AI employee's file to work on (`input.file`, and its own file input, such as the Invoice Processor's `invoice`); `input.event` holds its name, path, size and time. Hidden files and files still being written (`.part`, `.filepart`, `.tmp`, `~$…`) are left alone, and a file is picked up only once it hasn't changed for *Wait before picking up* (30 seconds by default). Files already there when watching starts are left alone; a newer version of a file under the same name counts as new. With *Move picked-up files to* set, each picked-up file is moved there (renamed with the time when the name is taken), so the watched folder only holds what is waiting; leave it empty when several AI employees watch one folder. A file larger than *Largest file* (25 MB by default) is left where it is and named in the watcher's last error (Settings → Connections) for as long as it stays there; a missing watched folder is an error too. Studio gives a new AI employee this duty when its work arrives in a shared folder or on an SFTP server; IT then connects the folder.

*SFTP.* Sign in with an SSH key (OpenSSH or PEM; give the server's administrator the public key) or a password. The server's host key is checked at every connection against *Host key fingerprint* (`SHA256:…` as `ssh-keygen -lf` shows it; MD5 fingerprints work too, several can be given). Test the connection without it: the test shows the fingerprint the server presents, and Settings → Connections asks someone to compare it with the server's administrator before trusting it. When the server later presents another key, nothing is sent and the connection says so. *Folder* is where AI employees work (empty: the account's home folder). Servers that don't allow renaming take *Write files directly*.

*Shared folders.* A network drive is mounted on the server that runs Enterprise Brain (for Docker, as a volume), and the server's operator allows it in `EB_SHARED_FOLDER_ROOTS` (folders separated by `:`, `;` on Windows): a connection can only use a folder inside one of them, so a company admin can't reach the server's own files. Links that lead out of the folder are neither followed nor listed, and nothing is written through a link.

**Calendars** answer the same way whatever is behind them: `find_free_times` takes the attendees, the length and the days to search, and returns the soonest times everyone is free within working hours (in the connection's time zone, Europe/Istanbul by default), at most two a day so the choice spans days, each with a label such as "Tue 6 Oct, 10:00–11:00". Calendars that couldn't be read are named, so the AI employee asks before booking. `book_meeting` is a write: at Shadow and Supervised a person approves it first.

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

**OAuth 2.0** (web services): with *client credentials* the connection gets its own tokens from the token URL (client ID and secret, scopes, an audience when the provider asks, the secret in the request or by basic authentication). With *someone signs in once* (authorization code with PKCE), an admin presses *Sign in* on the connection, allows access at the provider, and comes back; the refresh token is kept, encrypted, and replaced whenever the provider issues a new one. Register the redirect URL the form shows (`<EB_PUBLIC_URL>/api/connectors/oauth/callback`) with the provider. Tokens are only ever sent to https addresses, and a refused token is replaced once.

**Client certificates** (mutual TLS): web services and SAP S/4HANA on-premise take a client certificate and its private key (PEM), and the certificate of the company's own authority when the system's certificate comes from it. Requests then go over https only; redirects are followed within the same site, never to another one with the certificate. SAP gateways that sign callers in with the certificate alone use *Client certificate only*.

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
