/**
 * Ditto onboarding tutorial — STEP DEFINITIONS (data only).
 */
window.DITTO_ONBOARDING_STEPS = [
  {
    id: 'create-wallet',
    title: 'Create a wallet',
    why: 'Ditto needs a dedicated wallet so your copied trades stay separate from your personal funds.',
    actions: [
      'Install Rabby or MetaMask',
      'Create a new wallet (dedicated to Ditto)',
      'Save your recovery phrase offline'
    ],
    tab: null,
    target: null,
    completionCheck: null,
    manualComplete: true
  },
  {
    id: 'export-key',
    title: 'Export private key',
    why: 'The private key is the password to your trading wallet — Ditto uses it to sign trades on your behalf.',
    actions: [
      'Open wallet menu → Account details',
      'Show private key (confirm wallet password)',
      'Copy the 0x… string — only paste it into Ditto'
    ],
    tab: null,
    target: null,
    completionCheck: null,
    manualComplete: true
  },
  {
    id: 'add-key-to-bot',
    title: 'Add wallet to Ditto',
    why: 'Ditto stores your key encrypted so it can place copy trades automatically.',
    actions: [
      'Open the My Wallets tab',
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
    why: 'Polymarket needs to know your wallet before Ditto can trade on your account.',
    actions: [
      'Go to polymarket.com',
      'Connect wallet → approve in Rabby/MetaMask',
      'Accept terms (no deposit required)'
    ],
    tab: null,
    target: null,
    completionCheck: null,
    manualComplete: true
  },
  {
    id: 'builder-codes',
    title: 'Get builder credentials',
    why: 'Builder credentials let Ditto place orders through Polymarket’s official trading API.',
    actions: [
      'polymarket.com → Settings → Builder Profile',
      'Create a profile if you don\'t have one',
      'Copy API Key, Secret, and Passphrase'
    ],
    tab: null,
    target: null,
    completionCheck: null,
    manualComplete: true
  },
  {
    id: 'add-builder-credentials',
    title: 'Save builder credentials',
    why: 'Without these, Ditto cannot submit orders — even if everything else is configured.',
    actions: [
      'My Wallets → open wallet settings',
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
    why: 'USDC on Polygon is the currency Polymarket uses for trades; a little POL covers gas fees.',
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
    why: 'Once a wallet is on your Watch List and enabled, Start Copying tells Ditto to monitor and mirror trades.',
    actions: [
      'Follow a Jungle Agent or add a wallet to your Watch List',
      'Click Start Copying in the top bar',
      'Click again anytime to stop'
    ],
    tab: 'dashboard',
    target: '#startStopBtn',
    completionCheck: 'botRunning'
  }
];

window.DITTO_ONBOARDING_INTRO = 'This setup takes about 15 minutes. You can skip any step and come back later.';
