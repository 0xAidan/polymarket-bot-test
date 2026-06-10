/**
 * Ditto onboarding tutorial — STEP DEFINITIONS (data only).
 *
 * ── HOW TO ADD A VIDEO TO A STEP (no other code changes needed) ──────────────
 * 1. Record your screen recording and export it as an .mp4 file.
 * 2. Drop the file into  public/videos/  (create the folder if it's missing).
 *    Example:  public/videos/create-wallet.mp4
 * 3. Change that step's  videoSrc  below from  null  to  '/videos/create-wallet.mp4'
 * That's it. The player appears automatically; while videoSrc is null an elegant
 * "video coming soon" placeholder is shown instead.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Field reference:
 *   id              stable identifier (used for progress saving — don't change)
 *   title           heading shown on the card
 *   copy            array of paragraphs (plain text, written for total beginners)
 *   videoSrc        '/videos/<file>.mp4' or null for the placeholder
 *   tab             dashboard tab to open behind the card (null = stay put)
 *   target          CSS selector to spotlight behind the card (null = no spotlight)
 *   completionCheck name of a live check (see CHECKS in onboarding.js) or null.
 *                   When the check passes, the step shows a green "Detected" badge.
 *                   Steps can ALWAYS be advanced manually — checks never block you.
 */
window.DITTO_ONBOARDING_STEPS = [
  {
    id: 'create-wallet',
    title: 'Create a fresh wallet',
    copy: [
      'A crypto wallet is like a digital bank account that only you control. It has a public address (like an account number you can share) and a private key (like the master password — never share it).',
      'Install the Rabby or MetaMask browser extension, click "Create new wallet", and follow its steps. Write the recovery phrase on paper and keep it somewhere safe.',
      'Important: create a brand-new wallet just for Ditto. Don\'t reuse a wallet that holds your savings — keeping them separate keeps your other funds completely out of reach.'
    ],
    videoSrc: null,
    tab: null,
    target: null,
    completionCheck: null
  },
  {
    id: 'export-key',
    title: 'Safely export the private key',
    copy: [
      'Ditto needs the new wallet\'s private key so it can place trades for you automatically — think of it as giving a trusted assistant the key to one specific cash drawer, not your whole house.',
      'In Rabby: click the wallet menu → "Add address" details → "Private key". In MetaMask: three-dot menu → Account details → "Show private key". You\'ll confirm your wallet password first.',
      'Copy the long string that starts with "0x". Don\'t email it, don\'t screenshot it, don\'t paste it anywhere except into Ditto in the next step.'
    ],
    videoSrc: null,
    tab: null,
    target: null,
    completionCheck: null
  },
  {
    id: 'add-key-to-bot',
    title: 'Paste the key into Ditto',
    copy: [
      'Now hand that key to Ditto. Open the Trading Wallets tab, create your vault password if asked (this encrypts everything you store — there is no reset, so save it!), then paste the private key into the "Private Key" field and give the wallet a name.',
      'Your key is encrypted with bank-grade encryption (AES-256) before it ever touches the disk. Nobody — including us — can read it without your vault password.',
      'When the wallet appears in your list, this step is done. You\'ll see a green "Detected" badge below.'
    ],
    videoSrc: null,
    tab: 'trading-wallets',
    target: '#tab-trading-wallets',
    completionCheck: 'tradingWalletExists'
  },
  {
    id: 'connect-polymarket',
    title: 'Connect the wallet to Polymarket',
    copy: [
      'Polymarket is the prediction market where the trades happen. Your new wallet needs to say hello to it once, so Polymarket creates a trading account for it.',
      'Go to polymarket.com, click "Sign up" → "Connect wallet", and pick the wallet you just created (Rabby or MetaMask will pop up — approve the connection).',
      'Accept Polymarket\'s terms when prompted. You don\'t need to deposit anything on their site — just connecting once is enough.'
    ],
    videoSrc: null,
    tab: null,
    target: null,
    completionCheck: null
  },
  {
    id: 'builder-codes',
    title: 'Get your builder codes from Polymarket',
    copy: [
      'Builder codes are like an API badge — they tell Polymarket "this software is allowed to trade on my behalf". You get them for free from your Polymarket settings.',
      'While logged in at polymarket.com, open Settings (click your profile picture) and find the "Builder Profile" section. Create a builder profile if you don\'t have one.',
      'You\'ll see an API Key, Secret, and Passphrase. Keep this browser tab open — you\'ll copy all three into Ditto in the next step.'
    ],
    videoSrc: null,
    tab: null,
    target: null,
    completionCheck: null
  },
  {
    id: 'add-builder-credentials',
    title: 'Paste the builder credentials into Ditto',
    copy: [
      'Back in the Trading Wallets tab, open your wallet\'s settings and paste the three values from Polymarket into the API Key, API Secret, and API Passphrase fields, then save.',
      'These three values plus your private key make the wallet fully armed: Ditto can now sign trades AND submit them to Polymarket\'s order book.',
      'When Ditto sees credentials attached to your wallet, the green "Detected" badge appears below.'
    ],
    videoSrc: null,
    tab: 'trading-wallets',
    target: '#tab-trading-wallets',
    completionCheck: 'tradingWalletHasCredentials'
  },
  {
    id: 'fund-wallet',
    title: 'Fund the wallet',
    copy: [
      'The bot trades with USDC — a "stablecoin" where 1 USDC is always worth 1 US dollar. Your wallet needs some USDC on the Polygon network, plus a tiny bit of POL (a few cents) to pay network fees.',
      'The easiest route: buy USDC on an exchange like Coinbase and withdraw it to your wallet address — make sure you select the POLYGON network when withdrawing, not Ethereum.',
      'Start small. $20–50 is plenty to watch the bot work before you trust it with more. The green badge appears when Ditto sees a balance.'
    ],
    videoSrc: null,
    tab: 'dashboard',
    target: '.j-dash-hero',
    completionCheck: 'walletFunded'
  },
  {
    id: 'start-bot',
    title: 'Start the bot',
    copy: [
      'Last step. Pick who to copy: open the Jungle Agents tab and follow an agent with one click, or add any wallet address yourself under Tracked Wallets.',
      'Then press the gold Start button in the top bar. Ditto begins watching your chosen wallets around the clock and copies their trades using your settings.',
      'You can stop at any time with the same button. Trade history shows every copy attempt — green for executed, with reasons when something was skipped on purpose (filters protecting you).'
    ],
    videoSrc: null,
    tab: 'dashboard',
    target: '#startStopBtn',
    completionCheck: 'botRunning'
  }
];
