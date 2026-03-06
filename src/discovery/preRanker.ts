export const preRankDiscoveryCandidates = <
  T extends { whaleScore?: number; volume7d?: number; verification?: { trustLevel: 'provisional' | 'verified' | 'suppressed' } }
>(candidates: T[]): T[] => {
  const trustRank = { verified: 0, provisional: 1, suppressed: 2 };
  return [...candidates].sort((a, b) => {
    const trustDiff = trustRank[a.verification?.trustLevel || 'suppressed'] - trustRank[b.verification?.trustLevel || 'suppressed'];
    if (trustDiff !== 0) return trustDiff;
    const scoreDiff = Number(b.whaleScore || 0) - Number(a.whaleScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return Number(b.volume7d || 0) - Number(a.volume7d || 0);
  });
};
