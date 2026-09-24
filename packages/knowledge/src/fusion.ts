/** The customary RRF constant (Cormack et al., 2009). */
export const RRF_K = 60;

export interface FusedResult {
  id: string;
  /** Sum over rankings of 1 / (k + rank). */
  score: number;
  /** 1-based rank of the id in each input ranking (undefined when absent). */
  ranks: (number | undefined)[];
}

/**
 * Reciprocal Rank Fusion of several rankings (ids, best first). Duplicate ids
 * within a ranking count once, at their best rank. Ties are broken by best
 * individual rank, then by id, so the output is deterministic.
 */
export function reciprocalRankFusion(rankings: readonly (readonly string[])[], k = RRF_K): FusedResult[] {
  const fused = new Map<string, FusedResult>();
  rankings.forEach((ranking, list) => {
    let rank = 0;
    for (const id of ranking) {
      let entry = fused.get(id);
      if (entry?.ranks[list] !== undefined) continue;
      rank++;
      if (!entry) {
        entry = { id, score: 0, ranks: rankings.map(() => undefined) };
        fused.set(id, entry);
      }
      entry.ranks[list] = rank;
      entry.score += 1 / (k + rank);
    }
  });
  const bestRank = (entry: FusedResult) => Math.min(...entry.ranks.map((r) => r ?? Number.POSITIVE_INFINITY));
  return [...fused.values()].sort((a, b) => b.score - a.score || bestRank(a) - bestRank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
