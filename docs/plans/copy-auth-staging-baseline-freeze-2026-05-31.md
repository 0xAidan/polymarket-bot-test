# Copy/Auth Staging Baseline Freeze (2026-05-31)

This document freezes the code baseline used for the copy-trading + hosted-auth remediation program.

## Purpose

- Lock the implementation source-of-truth before parity work.
- Prevent accidental drift from mixed staging/runtime states.
- Keep Discovery out of scope except for unavoidable shared surfaces.

## Baseline Hashes (Repository)

- `main` (local): `a22072d2bfdb6375c3f83a7376db4b4d6faadf9e`
- `origin/main`: `13d0debb5777fc8f6c1c7ed952d2404f0aa5514b`
- `origin/feature/ditto-jungle-preview` (staging target branch): `72d741912cead39e22ff0bb2dcdcf3962fe6bb51`
- `origin/staging`: `46513412665cd89509a259bdb6fe337a4994d5d9`
- `origin/integrate/pr47-api-auth`: `6b6ca5a80a116c95203fd5437c279174f144d143`

## Scoped Parity Diff (main -> origin/feature/ditto-jungle-preview)

Copy/auth scoped files with differences:

- `package.json`
- `public/index.html`
- `public/js/api.js`
- `public/js/app.js`
- `src/api/routes.ts`
- `src/clobClient.ts`
- `src/clobClientFactory.ts`
- `src/copyTrader.ts`
- `src/database.ts`
- `src/secureKeyManager.ts`
- `src/server.ts`
- `src/tradeExecutor.ts`
- `src/walletManager.ts`
- `src/walletMonitor.ts`

Scoped diff summary:

- `14 files changed`
- `680 insertions`
- `1693 deletions`

## Runtime Provenance Status

The repository baseline above is frozen, but production-grade parity requires
matching this against the actual server runtime state on staging.

Status right now:

- Repository baseline: `FROZEN`
- Staging server exact runtime commit: `UNVERIFIED`
- Staging server dirty working tree diff: `UNVERIFIED`

## Required Runtime Capture (must be completed before final cutover approval)

Run on staging server path only (`/opt/polymarket-bot-staging`):

```bash
git rev-parse HEAD
git status --porcelain
git branch --show-current
```

If dirty, capture and archive:

```bash
git diff -- src/server.ts src/api/routes.ts src/walletMonitor.ts src/walletManager.ts src/secureKeyManager.ts src/copyTrader.ts src/tradeExecutor.ts src/clobClient.ts src/clobClientFactory.ts src/storage.ts src/database.ts public/index.html public/js/api.js public/js/app.js package.json
```

## Source-of-Truth Rule for This Program

Until runtime provenance is captured and approved, treat:

1. `origin/feature/ditto-jungle-preview` as the implementation source branch for copy/auth parity work, and
2. this document as the frozen baseline ledger.

