const normalizeSurfaceBucketValue = (value) => String(value || 'watch_only').toLowerCase();

const normalizeTrustScore = (wallet) => Number.isFinite(Number(wallet?.trustScore))
  ? Number(wallet.trustScore)
  : Number(wallet?.separateScores?.trust || 0);

const getDiscoveryColumnBucket = (wallet) => {
  const surfaceBucket = normalizeSurfaceBucketValue(wallet?.surfaceBucket);
  if (surfaceBucket === 'copyable') return 'copyable';
  if (surfaceBucket === 'trusted') return 'trusted';
  if (surfaceBucket === 'emerging') return 'emerging';
  return 'watch-only';
};

globalThis.DiscoveryCore = {
  ...(globalThis.DiscoveryCore || {}),
  normalizeTrustScore,
  getDiscoveryColumnBucket,
};
