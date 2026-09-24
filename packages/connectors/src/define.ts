import { ConnectorManifest } from "@enterprise-brain/core";
import { validateOperationInput } from "./tools.ts";
import {
  ConnectorError,
  type ConnectorContext,
  type ConnectorEvent,
  type ConnectorImplementation,
  type ConnectorTestResult,
} from "./types.ts";
import { errorMessage, isRecord, type Input } from "./util.ts";

/** Manifest as authored (defaults such as maturity or config: [] may be omitted). */
export type ConnectorManifestInput = (typeof ConnectorManifest)["_input"];
export type ConfigFieldInput = NonNullable<ConnectorManifestInput["config"]>[number];

/** Parses (and thereby validates) a manifest at module load, filling in defaults. */
export function defineManifest(input: ConnectorManifestInput): ConnectorManifest {
  return ConnectorManifest.parse(input);
}

export type OperationHandler = (input: Input, ctx: ConnectorContext) => Promise<unknown>;

export interface ConnectorDefinition {
  manifest: ConnectorManifest;
  test(ctx: ConnectorContext): Promise<ConnectorTestResult>;
  operations: Record<string, OperationHandler>;
  poll?(eventId: string, ctx: ConnectorContext, cursor?: string): Promise<{ events: ConnectorEvent[]; cursor?: string }>;
}

/**
 * Builds a ConnectorImplementation from a manifest and one handler per
 * operation. Inputs are validated against the operation's JSON Schema before a
 * handler runs, unknown operations are rejected, and `test()` never throws (a
 * failure is reported as `{ ok: false }`).
 */
export function defineConnector(definition: ConnectorDefinition): ConnectorImplementation {
  const { manifest, operations } = definition;
  const declared = new Set(manifest.operations.map((op) => op.id));
  for (const id of declared) {
    if (!operations[id]) throw new Error(`Connector ${manifest.type}: operation "${id}" has no handler`);
  }
  for (const id of Object.keys(operations)) {
    if (!declared.has(id)) throw new Error(`Connector ${manifest.type}: handler "${id}" is not declared in the manifest`);
  }

  const implementation: ConnectorImplementation = {
    manifest,
    async test(ctx) {
      try {
        return await definition.test(ctx);
      } catch (error) {
        const code = error instanceof ConnectorError ? error.code : "remote";
        return { ok: false, message: errorMessage(error), details: { code } };
      }
    },
    async execute(operationId, input, ctx) {
      const handler = Object.hasOwn(operations, operationId) ? operations[operationId] : undefined;
      if (!handler) {
        throw new ConnectorError(`${manifest.name} has no operation "${operationId}"`, "unsupported");
      }
      const payload: Input = isRecord(input) ? input : {};
      const problems = validateOperationInput(manifest, operationId, payload);
      if (problems.length > 0) {
        throw new ConnectorError(`Invalid input for ${manifest.type}.${operationId}: ${problems.join("; ")}`, "validation");
      }
      return handler(payload, ctx);
    },
  };
  if (definition.poll) {
    const poll = definition.poll;
    implementation.poll = async (eventId, ctx, cursor) => {
      if (!manifest.events.some((event) => event.id === eventId)) {
        throw new ConnectorError(`${manifest.name} has no event "${eventId}"`, "unsupported");
      }
      return poll(eventId, ctx, cursor);
    };
  }
  return implementation;
}
