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
    id: 'create-wallet',
    title: 'Create a wallet',
    actions: [
      'Install any Polymarket-compatible wallet (MetaMask, Rabby, Rainbow, etc.)',
      'Create a new wallet (dedicated to Ditto)',
      'Save your recovery phrase offline'
    ],
    tab: null,
    target: null,
    completionCheck: null
  },
  {
    id: 'export-key',
    title: 'Export private key',
    actions: [
      'Open wallet menu → Account details',
      'Show private key (confirm wallet password)',
      'Copy the 0x… string — only paste it into Ditto'
    ],
    tab: null,
    target: null,
    completionCheck: null
  },
  {
    id: 'add-key-to-bot',
    title: 'Add wallet to Ditto',
    actions: [
      'Open the Trading Wallets tab',
      'Paste private key, name the wallet, save',
      'Unlock vault if prompted'
    ],
    tab: 'trading-wallets',
    target: '#tab-trading-wallets',
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
    id: 'builder-codes',
    title: 'Get builder credentials',
    actions: [
      'polymarket.com → Settings → Builder Profile',
      'Create a profile if you don\'t have one',
      'Copy API Key, Secret, and Passphrase'
    ],
    tab: null,
    target: null,
    completionCheck: null
  },
  {
    id: 'add-builder-credentials',
    title: 'Save builder credentials',
    actions: [
      'Trading Wallets → open wallet settings',
      'Paste API Key, Secret, and Passphrase',
      'Save'
    ],
    tab: 'trading-wallets',
    target: '#tab-trading-wallets',
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
      'Add a tracked wallet or follow a Jungle Agent',
      'Click Start in the top bar',
      'Click again anytime to stop'
    ],
    tab: 'dashboard',
    target: '#startStopBtn',
    completionCheck: 'botRunning'
  }
];
