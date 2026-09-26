import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { BuilderError } from "@enterprise-brain/builder";
import { ConnectorError } from "@enterprise-brain/connectors";
import { RecordValueError } from "@enterprise-brain/core";
import {
  AgentNotFoundError,
  AppError,
  CalculationError,
  CoachingError,
  PeopleError,
  RecurringWorkError,
  RunError,
  TableError,
  TaskError,
  WorkError,
  type CompanyRow,
  type Platform,
} from "@enterprise-brain/runtime";
import { KnowledgeError } from "@enterprise-brain/knowledge";
import { HermesRequestError } from "@enterprise-brain/paperclip";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof RunError || error instanceof BuilderError || error instanceof HermesRequestError) return error.status;
  if (error instanceof AgentNotFoundError) return 404;
  if (
    error instanceof PeopleError ||
    error instanceof TaskError ||
    error instanceof WorkError ||
    error instanceof CoachingError ||
    error instanceof TableError ||
    error instanceof AppError ||
    error instanceof CalculationError ||
    error instanceof RecurringWorkError
  )
    return error.status;
  if (error instanceof RecordValueError) return 400;
  if (error instanceof KnowledgeError) return error.code === "not_found" ? 404 : 400;
  if (error instanceof ZodError) return 400;
  if (error instanceof ConnectorError) {
    return { config: 400, auth: 502, not_found: 404, validation: 400, remote: 502, unsupported: 400 }[error.code] ?? 500;
  }
  const status = (error as { statusCode?: number }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 600) return status;
  if (error instanceof Error && /not found/i.test(error.message)) return 404;
  return 500;
}

export function errorBody(error: unknown) {
  if (error instanceof ZodError) {
    return { error: "Invalid request", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  // Every value that doesn't fit its field, at once.
  if (error instanceof RecordValueError) return { error: error.message, problems: error.problems };
  if (error instanceof AppError && error.problems.length) return { error: error.message, problems: error.problems };
  return { error: error instanceof Error ? error.message : String(error) };
}

export async function companyOf(platform: Platform, request: FastifyRequest): Promise<CompanyRow> {
  const ref = (request.params as { company?: string }).company;
  if (!ref) throw new HttpError(400, "Missing company");
  const company = await platform.company(ref);
  // People only see their own company; the API key and open mode see any.
  const viewerCompany = request.viewer?.companyId;
  if (!company || (viewerCompany && viewerCompany !== company.id)) throw new HttpError(404, `Company "${ref}" not found`);
  return company;
}

export function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  const apiKey = request.headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey : undefined;
}

/** Start a Server-Sent Events response. */
export function sse(reply: FastifyReply) {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const heartbeat = setInterval(() => raw.write(": ping\n\n"), 15_000);
  let closed = false;
  raw.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
  });
  return {
    send(event: string, data: unknown) {
      if (!closed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      if (!closed) raw.end();
      closed = true;
    },
    get closed() {
      return closed;
    },
    onClose(fn: () => void) {
      raw.on("close", fn);
    },
  };
}

/** Read a multipart request: files are stored, text fields returned. */
export async function readMultipart(
  platform: Platform,
  companyId: string,
  request: FastifyRequest,
  source = "upload",
): Promise<{ fields: Record<string, string>; files: { field: string; id: string; name: string; mimeType: string; size: number }[] }> {
  const fields: Record<string, string> = {};
  const files: { field: string; id: string; name: string; mimeType: string; size: number }[] = [];
  for await (const part of request.parts()) {
    if (part.type === "file") {
      const data = await part.toBuffer();
      if (!data.length) continue;
      const stored = await platform.files.put(companyId, { name: part.filename, data, mimeType: part.mimetype, source });
      files.push({ field: part.fieldname, id: stored.id, name: stored.name, mimeType: stored.mimeType, size: stored.size });
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  return { fields, files };
}
