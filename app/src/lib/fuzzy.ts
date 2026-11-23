// Small fuzzy matcher (subsequence with bonuses for word starts and contiguity).
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return null;
    score += idx === prev + 1 ? 5 : 1;
    if (idx === 0 || /[\s/_\-.]/.test(t[idx - 1])) score += 3;
    prev = idx;
    ti = idx + 1;
  }
  return score - t.length * 0.01;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string, limit = 100): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
