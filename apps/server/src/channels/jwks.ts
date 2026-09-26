import type { JSONWebKeySet } from "jose";

const DAY = 24 * 3600_000;
const REFRESH_AT_MOST_EVERY = 5 * 60_000;

export async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

interface Entry {
  set: JSONWebKeySet;
  fetchedAt: number;
}

/**
 * Published signing keys by source, cached for a day, and fetched again for a key not seen yet (at most
 * every few minutes, so unknown keys can't make the server hammer the publisher).
 */
export class KeySets {
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Entry>>();

  constructor(private readonly load: (source: string) => Promise<unknown> = fetchJson) {}

  async get(source: string, kid?: string): Promise<JSONWebKeySet> {
    const entry = this.entries.get(source);
    const age = entry ? Date.now() - entry.fetchedAt : Infinity;
    const unknown = kid !== undefined && entry !== undefined && !entry.set.keys.some((k) => k.kid === kid);
    if (entry && age < DAY && !(unknown && age > REFRESH_AT_MOST_EVERY)) return entry.set;
    let pending = this.loading.get(source);
    if (!pending) {
      pending = this.load(source)
        .then((data) => {
          const set = data as JSONWebKeySet;
          if (!set || !Array.isArray(set.keys)) throw new Error(`No signing keys at ${source}`);
          const loaded = { set, fetchedAt: Date.now() };
          this.entries.set(source, loaded);
          return loaded;
        })
        .finally(() => this.loading.delete(source));
      this.loading.set(source, pending);
    }
    return (await pending).set;
  }
}
