import { createHash } from "node:crypto";

/**
 * Embedding providers. All produce vectors of the same dimension as the
 * knowledge_chunks.embedding column (1024) so providers can be swapped without
 * a schema change (re-index when switching).
 */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

export const EMBEDDING_DIMENSIONS = 1024;

function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export function tokenizeForEmbedding(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .split(/[^a-z0-9@.+#]+/)
    .map((t) => t.replace(/^[.]+|[.]+$/g, ""))
    .filter((t) => t.length > 1);
}

/**
 * Offline embedding: signed feature hashing over word unigrams, bigrams and
 * character trigrams. Lexical rather than semantic, but deterministic, free and
 * good enough (combined with full-text ranking) for demos and air-gapped
 * installs. Use Voyage or OpenAI embeddings in production.
 */
export class LocalHashEmbedder implements Embedder {
  readonly model = "local-hash-v1";
  readonly dimensions: number;

  constructor(dimensions = EMBEDDING_DIMENSIONS) {
    this.dimensions = dimensions;
  }

  private bucket(feature: string): [number, number] {
    const digest = createHash("md5").update(feature).digest();
    const index = digest.readUInt32LE(0) % this.dimensions;
    const sign = (digest[4]! & 1) === 0 ? 1 : -1;
    return [index, sign];
  }

  embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenizeForEmbedding(text);
    const add = (feature: string, weight: number) => {
      const [i, s] = this.bucket(feature);
      vec[i] = (vec[i] ?? 0) + s * weight;
    };
    tokens.forEach((token, i) => {
      add(`w:${token}`, 1);
      if (i > 0) add(`b:${tokens[i - 1]}_${token}`, 0.5);
      if (token.length > 4) {
        for (let j = 0; j + 3 <= token.length; j++) add(`c:${token.slice(j, j + 3)}`, 0.2);
      }
    });
    return normalize(vec);
  }

  async embed(texts: string[], _kind: "document" | "query" = "document"): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/** Voyage AI embeddings (Anthropic's recommended embeddings partner). */
export class VoyageEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  constructor(
    private readonly apiKey: string,
    readonly model = "voyage-3.5",
  ) {}

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const json = (await postJson("https://api.voyageai.com/v1/embeddings", this.apiKey, {
        input: batch,
        model: this.model,
        input_type: kind,
        output_dimension: this.dimensions,
      })) as { data: { embedding: number[] }[] };
      out.push(...json.data.map((d) => d.embedding));
    }
    return out;
  }
}

export class OpenAIEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  constructor(
    private readonly apiKey: string,
    readonly model = "text-embedding-3-small",
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async embed(texts: string[], _kind: "document" | "query" = "document"): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 128) {
      const batch = texts.slice(i, i + 128);
      const json = (await postJson(`${this.baseUrl}/embeddings`, this.apiKey, {
        input: batch,
        model: this.model,
        dimensions: this.dimensions,
      })) as { data: { embedding: number[] }[] };
      out.push(...json.data.map((d) => d.embedding));
    }
    return out;
  }
}

export function createEmbedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  const provider = env.EB_EMBEDDINGS_PROVIDER ?? (env.VOYAGE_API_KEY ? "voyage" : env.OPENAI_API_KEY ? "openai" : "local");
  if (provider === "voyage" && env.VOYAGE_API_KEY) return new VoyageEmbedder(env.VOYAGE_API_KEY, env.EB_EMBEDDINGS_MODEL ?? "voyage-3.5");
  if (provider === "openai" && env.OPENAI_API_KEY) {
    return new OpenAIEmbedder(env.OPENAI_API_KEY, env.EB_EMBEDDINGS_MODEL ?? "text-embedding-3-small", env.OPENAI_BASE_URL);
  }
  return new LocalHashEmbedder();
}
