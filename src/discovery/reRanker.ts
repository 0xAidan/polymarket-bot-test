export const reRankDiscoveryCandidates = <
  T extends { focusCategory?: string; verification?: { trustLevel: 'provisional' | 'verified' | 'suppressed' }; whaleScore?: number }
>(candidates: T[]): T[] => {
  const seenCategories = new Map<string, number>();
  return [...candidates].sort((a, b) => {
    const leftPenalty = seenCategories.get(a.focusCategory || 'unknown') || 0;
    const rightPenalty = seenCategories.get(b.focusCategory || 'unknown') || 0;
    const leftScore = Number(a.whaleScore || 0) - leftPenalty * 2;
    const rightScore = Number(b.whaleScore || 0) - rightPenalty * 2;
    const diff = rightScore - leftScore;
    if (diff !== 0) return diff;
    return 0;
  }).map((candidate) => {
    const key = candidate.focusCategory || 'unknown';
    seenCategories.set(key, (seenCategories.get(key) || 0) + 1);
    return candidate;
  });
};
