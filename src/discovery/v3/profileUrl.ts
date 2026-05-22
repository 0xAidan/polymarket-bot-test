/**
 * Polymarket profile links for Discovery v3 cards.
 *
 * Gamma `name` is the public @handle (e.g. dvisik). Linking to `@0x…` often
 * opens the wrong or empty profile while the card subtitle shows `@duderr`.
 */
export function buildPolymarketProfileUrl(
  proxyWallet: string,
  profileName?: string | null
): string {
  const address = proxyWallet.trim().toLowerCase();
  const slug = profileName?.trim();
  if (slug && !slug.startsWith('0x') && /^[a-zA-Z0-9_-]+$/.test(slug)) {
    return `https://polymarket.com/@${slug}`;
  }
  return `https://polymarket.com/profile/${address}`;
}
