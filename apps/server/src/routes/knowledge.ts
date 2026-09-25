import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { humanizeKey, slugify } from "@enterprise-brain/core";
import { extractDocument } from "@enterprise-brain/documents";
import { requireAnyManager } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf, readMultipart } from "../http.ts";

export async function knowledgeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  app.get("/api/companies/:company/knowledge/collections", async (request) => {
    const company = await companyOf(platform, request);
    return platform.knowledge.listCollections(company.id);
  });

  app.post("/api/companies/:company/knowledge/collections", async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    const body = z.object({ name: z.string().min(1), key: z.string().optional(), description: z.string().optional() }).parse(request.body);
    return platform.knowledge.ensureCollection(company.id, { key: body.key ?? slugify(body.name), name: body.name, description: body.description });
  });

  app.delete("/api/companies/:company/knowledge/collections/:collection", async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    const { collection } = request.params as { collection: string };
    await platform.knowledge.deleteCollection(company.id, collection);
    return { ok: true };
  });

  app.get("/api/companies/:company/knowledge/documents", async (request) => {
    const company = await companyOf(platform, request);
    const { collection } = z.object({ collection: z.string().optional() }).parse(request.query);
    return platform.knowledge.listDocuments(company.id, collection);
  });

  /** Add documents: multipart files (+ `collection` field) or JSON {collection, title, text}. */
  app.post("/api/companies/:company/knowledge/documents", async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    if (request.isMultipart()) {
      const { fields, files } = await readMultipart(platform, company.id, request, "knowledge");
      const collection = fields.collection || "general";
      await platform.knowledge.ensureCollection(company.id, { key: collection, name: humanizeKey(collection) });
      const documents = [];
      for (const f of files) {
        const file = await platform.files.get(company.id, f.id);
        const doc = await extractDocument({ data: file.data, fileName: file.name, mimeType: file.mimeType }, { llm: platform.llm });
        documents.push(
          await platform.knowledge.ingestText(company.id, collection, {
            title: file.name.replace(/\.[^.]+$/, ""),
            text: doc.text,
            source: "upload",
            fileId: f.id,
            mimeType: file.mimeType,
            metadata: { language: doc.language, documentType: doc.documentType },
          }),
        );
      }
      await platform.activity.record(company.id, { actor: "user", action: "knowledge.uploaded", entityType: "collection", entityId: collection, summary: `Added ${documents.length} document(s) to ${collection}` });
      return documents;
    }
    const body = z.object({ collection: z.string().default("general"), title: z.string().min(1), text: z.string().min(1), uri: z.string().optional() }).parse(request.body);
    await platform.knowledge.ensureCollection(company.id, { key: body.collection, name: humanizeKey(body.collection) });
    return platform.knowledge.ingestText(company.id, body.collection, { title: body.title, text: body.text, uri: body.uri, source: "text" });
  });

  app.get("/api/companies/:company/knowledge/documents/:document", async (request) => {
    const company = await companyOf(platform, request);
    const { document } = request.params as { document: string };
    const found = await platform.knowledge.getDocument(company.id, document);
    if (!found) throw new HttpError(404, "Document not found");
    return found;
  });

  app.delete("/api/companies/:company/knowledge/documents/:document", async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    const { document } = request.params as { document: string };
    await platform.knowledge.deleteDocument(company.id, document);
    return { ok: true };
  });

  app.post("/api/companies/:company/knowledge/search", async (request) => {
    const company = await companyOf(platform, request);
    const body = z.object({ query: z.string().min(1), collections: z.array(z.string()).optional(), topK: z.number().int().positive().max(50).optional() }).parse(request.body);
    const started = Date.now();
    const hits = await platform.knowledge.search(company.id, body.query, { collections: body.collections, topK: body.topK ?? 10 });
    return { query: body.query, tookMs: Date.now() - started, embeddingModel: platform.embedder.model, hits };
  });
}
