/**
 * Ditto onboarding tutorial — STEP DEFINITIONS (data only).
 *
 * Field reference:
 *   id              stable identifier (used for progress saving — don't change)
 *   title           heading shown on the card
 *   actions         short imperative steps (rendered as a numbered list)
 *   tab             dashboard tab to open behind the card (null = stay put)
 *   target          CSS selector to spotlight behind the card (null = no spotlight)
 *   completionCheck name of a live check (see CHECKS in onboarding.js) or null.
 *                   When the check passes, the step shows a green "Detected" badge.
 *                   Steps can ALWAYS be advanced manually — checks never block you.
 */
window.DITTO_ONBOARDING_STEPS = [
  {
    id: 'setup-wallet',
    title: 'Set up your wallet',
    actions: [
      'Install any Polymarket-compatible wallet (MetaMask, Rabby, Rainbow, etc.)',
      'Get your private key',
      'Add it in Trading Wallets → save'
    ],
    tab: 'trading-wallets',
    target: '.j-nav-btn[data-tab="trading-wallets"]',
    completionCheck: 'tradingWalletExists'
  },
  {
    id: 'connect-polymarket',
    title: 'Connect on Polymarket',
    actions: [
      'Go to polymarket.com',
      'Connect wallet → approve in your wallet extension',
      'Accept terms (no deposit required)'
    ],
    tab: null,
    target: null,
    completionCheck: null
  },
  {
    id: 'builder-credentials',
    title: 'Add builder credentials',
    actions: [
      'polymarket.com → Settings → Builder Profile → copy API Key, Secret, and Passphrase',
      'Trading Wallets → open wallet settings → paste and save'
    ],
    tab: 'trading-wallets',
    target: '.j-nav-btn[data-tab="trading-wallets"]',
    completionCheck: 'tradingWalletHasCredentials'
  },
  {
    id: 'fund-wallet',
    title: 'Fund the wallet',
    actions: [
      'Send USDC on Polygon to your wallet address',
      'Include a small amount of POL for gas',
      'Balance appears on the dashboard when it arrives'
    ],
    tab: 'dashboard',
    target: '.j-dash-hero',
    completionCheck: 'walletFunded'
  },
  {
    id: 'start-bot',
    title: 'Start copying',
    actions: [
      'Browse Jungle Agents and follow one you like',
      'Configure copy settings for each wallet before you enable it',
      'Click Start in the top bar — click again to stop'
    ],
    tab: 'jungle-agents',
    target: null,
    completionCheck: 'botRunning'
  }
];
