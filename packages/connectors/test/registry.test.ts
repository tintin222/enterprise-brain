import { ConnectorManifest, SystemCategory } from "@enterprise-brain/core";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_CONNECTORS,
  ConnectorError,
  ConnectorRegistry,
  createDefaultRegistry,
  defineConnector,
  defineManifest,
  operationToolName,
  sandboxConnectorFor,
  validateOperationInput,
  type ConnectorImplementation,
} from "../src/index.ts";
import { makeCtx } from "./helpers.ts";

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe("connector manifests", () => {
  it("all built-in manifests parse with ConnectorManifest.parse", () => {
    for (const connector of BUILTIN_CONNECTORS) {
      expect(() => ConnectorManifest.parse(connector.manifest), connector.manifest.type).not.toThrow();
    }
  });

  it("have object input schemas, unique operation ids and IT requirements for real systems", () => {
    for (const { manifest } of BUILTIN_CONNECTORS) {
      const ids = manifest.operations.map((op) => op.id);
      expect(new Set(ids).size, manifest.type).toBe(ids.length);
      for (const op of manifest.operations) {
        expect(op.input.type, `${manifest.type}.${op.id}`).toBe("object");
        const required = (op.input.required ?? []) as string[];
        const properties = (op.input.properties ?? {}) as Record<string, unknown>;
        for (const key of required) expect(properties[key], `${manifest.type}.${op.id}.${key}`).toBeDefined();
      }
      if (manifest.maturity === "preview") {
        expect(manifest.itRequirements.length, manifest.type).toBeGreaterThanOrEqual(2);
        if (manifest.vendor !== "Enterprise Brain") expect(manifest.docsUrl, manifest.type).toMatch(/^https:\/\//);
      }
      expect(SystemCategory.options).toContain(manifest.category);
    }
  });

  it("marks secret config fields as password fields", () => {
    for (const { manifest } of BUILTIN_CONNECTORS) {
      for (const field of manifest.config) {
        if (field.secret) expect(["password", "textarea"], `${manifest.type}.${field.key}`).toContain(field.type);
      }
    }
  });

  it("exposes every operation under a valid tool name", () => {
    for (const { manifest } of BUILTIN_CONNECTORS) {
      for (const op of manifest.operations) expect(operationToolName(manifest.type, op.id)).toMatch(TOOL_NAME);
    }
  });
});

describe("ConnectorRegistry", () => {
  it("registers the built-in connectors", () => {
    const registry = createDefaultRegistry();
    expect(registry.list().length).toBeGreaterThanOrEqual(15);
    for (const type of [
      "sandbox-erp",
      "sandbox-crm",
      "sandbox-hris",
      "sandbox-ats",
      "sandbox-itsm",
      "sap-s4hana",
      "microsoft-dynamics-365",
      "salesforce",
      "hubspot",
      "microsoft-365-mail",
      "imap-smtp",
      "gmail",
      "sharepoint",
      "sap-successfactors",
      "rest-api",
      "sql-database",
      "webhook-inbound",
    ]) {
      expect(registry.has(type), type).toBe(true);
      expect(registry.get(type)?.manifest.type).toBe(type);
    }
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.listByCategory("mail").map((m) => m.type)).toEqual(["microsoft-365-mail", "imap-smtp", "gmail"]);
  });

  it("rejects duplicate types and invalid manifests", () => {
    const registry = createDefaultRegistry();
    expect(() => registry.register(BUILTIN_CONNECTORS[0]!)).toThrow(/already registered/);
    const invalid = { ...BUILTIN_CONNECTORS[0]!, manifest: { ...BUILTIN_CONNECTORS[0]!.manifest, type: "Not Valid" } };
    expect(() => new ConnectorRegistry().register(invalid)).toThrow();
    expect(() => registry.require("unknown")).toThrow(ConnectorError);
  });

  it("maps categories to sandbox systems", () => {
    expect(sandboxConnectorFor("erp")).toBe("sandbox-erp");
    expect(sandboxConnectorFor("accounting")).toBe("sandbox-erp");
    expect(sandboxConnectorFor("scm")).toBe("sandbox-erp");
    expect(sandboxConnectorFor("crm")).toBe("sandbox-crm");
    expect(sandboxConnectorFor("hris")).toBe("sandbox-hris");
    expect(sandboxConnectorFor("ats")).toBe("sandbox-ats");
    expect(sandboxConnectorFor("itsm")).toBe("sandbox-itsm");
    expect(sandboxConnectorFor("mail")).toBeUndefined();
    expect(sandboxConnectorFor("constructor")).toBeUndefined();
    const registry = createDefaultRegistry();
    for (const category of SystemCategory.options) {
      const type = sandboxConnectorFor(category);
      if (type) expect(registry.get(type)?.manifest.maturity).toBe("sandbox");
    }
  });

  it("sandbox and webhook connectors pass test() without configuration", async () => {
    const registry = createDefaultRegistry();
    for (const type of ["sandbox-erp", "sandbox-crm", "sandbox-hris", "sandbox-ats", "sandbox-itsm", "webhook-inbound"]) {
      expect((await registry.require(type).test(makeCtx())).ok, type).toBe(true);
    }
  });

  it("real connectors report missing configuration from test() instead of throwing", async () => {
    const registry = createDefaultRegistry();
    for (const manifest of registry.list().filter((m) => m.maturity === "preview")) {
      const result = await registry.require(manifest.type).test(makeCtx());
      expect(result.ok, manifest.type).toBe(false);
      expect(result.details?.code, manifest.type).toBe("config");
    }
  });
});

describe("operationToolName", () => {
  it("joins ref and operation id", () => {
    expect(operationToolName("erp", "get_purchase_order")).toBe("erp__get_purchase_order");
  });

  it("sanitises characters outside [a-zA-Z0-9_-]", () => {
    expect(operationToolName("my erp.prod", "orders.list")).toBe("my_erp_prod__orders_list");
    expect(operationToolName("ünïcode", "x")).toMatch(TOOL_NAME);
  });

  it("truncates long names to 64 characters, keeping them unique and stable", () => {
    const a = operationToolName("a".repeat(50), "operation_number_one");
    const b = operationToolName("a".repeat(50), "operation_number_two");
    expect(a).toMatch(TOOL_NAME);
    expect(a.length).toBe(64);
    expect(a).not.toBe(b);
    expect(operationToolName("a".repeat(50), "operation_number_one")).toBe(a);
  });
});

describe("validateOperationInput", () => {
  const manifest = defineManifest({
    type: "demo",
    name: "Demo",
    vendor: "Test",
    category: "other",
    description: "demo",
    auth: "none",
    operations: [
      {
        id: "create_order",
        name: "Create order",
        description: "",
        kind: "write",
        input: {
          type: "object",
          required: ["customer", "lines"],
          properties: {
            customer: { type: "string" },
            email: { type: "string", format: "email" },
            due: { type: "string", format: "date" },
            priority: { type: "string", enum: ["low", "high"] },
            express: { type: "boolean" },
            lines: {
              type: "array",
              items: { type: "object", required: ["qty"], properties: { qty: { type: "integer" }, price: { type: "number" } } },
            },
          },
        },
      },
    ],
  });

  it("accepts valid input (null counts as not provided, enums are case-insensitive)", () => {
    expect(
      validateOperationInput(manifest, "create_order", {
        customer: "ACME",
        email: null,
        priority: "HIGH",
        due: "2026-10-01",
        lines: [{ qty: 2, price: 9.5 }],
      }),
    ).toEqual([]);
  });

  it("reports missing required properties, wrong types, enums and formats", () => {
    const problems = validateOperationInput(manifest, "create_order", {
      customer: "",
      email: "not-an-email",
      priority: "urgent",
      express: "yes",
      due: "01.10.2026",
      lines: [{ qty: 1.5 }, { price: "x" }],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "customer is required",
        "email must be an e-mail address",
        "priority must be one of: low, high",
        "express must be boolean (got string)",
        "due must be a date (YYYY-MM-DD)",
        "lines[0].qty must be integer (got number)",
        "lines[1].qty is required",
        "lines[1].price must be number (got string)",
      ]),
    );
  });

  it("reports unknown operations and non-object input", () => {
    expect(validateOperationInput(manifest, "nope", {})).toEqual(['Unknown operation "nope" for connector demo']);
    expect(validateOperationInput(manifest, "create_order", [])).toEqual(["input must be an object (got array)"]);
  });

  it("is enforced by defineConnector before a handler runs", async () => {
    let called = false;
    const connector: ConnectorImplementation = defineConnector({
      manifest,
      test: async () => ({ ok: true, message: "ok" }),
      operations: {
        create_order: async () => {
          called = true;
          return {};
        },
      },
    });
    const error = await connector.execute("create_order", { customer: "x" }, makeCtx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("validation");
    expect(called).toBe(false);
    const unsupported = await connector.execute("delete_everything", {}, makeCtx()).catch((e: unknown) => e);
    expect((unsupported as ConnectorError).code).toBe("unsupported");
  });

  it("defineConnector refuses manifests and handlers that do not match", () => {
    expect(() => defineConnector({ manifest, test: async () => ({ ok: true, message: "" }), operations: {} })).toThrow(/has no handler/);
  });
});
