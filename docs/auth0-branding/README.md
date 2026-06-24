# Auth0 — Jungle Agents Branding

The login/signup experience is served by Auth0 Universal Login, branded to match the
Jungle Agents design system (`public/shared/jungle-brand.css`).

## What's configured (applied via `apply.sh`)

| Piece | Value |
| --- | --- |
| Tenant | `dev-rjdevt32s21vhh86.us.auth0.com` (account linked to the owner's GitHub) |
| Application | "Ditto" (Regular Web App; renamed from legacy "Jungle Agents") |
| Tenant friendly name | "Ditto" |
| Custom text | "Log in to Ditto" / "Create your Ditto account" — see `custom-text-*.json` (includes `login-id` + `signup-id`) |

## How to re-apply (e.g. on a new tenant)

```bash
auth0 login          # log in to the tenant
bash docs/auth0-branding/apply.sh
```

## Production checklist (before launch)

**Start here:** [production-gate.md](./production-gate.md) — dev-keys alert, clean login URL, and copy push.

1. Set on the production server (values from the Auth0 dashboard → Applications → Jungle Agents):
   - `AUTH0_BASE_URL=https://ditto.jungle.win`
   - `AUTH0_ISSUER_BASE_URL=https://login.ditto.jungle.win` *(after custom domain — see [custom-domain-setup.md](./custom-domain-setup.md))*
   - `AUTH0_CLIENT_ID=<client id>`
   - `AUTH0_CLIENT_SECRET=<client secret>`
2. **Google dev keys (dashboard alert)** — not visible to end users, but must be fixed before GTM:
   - **Fast:** `bash docs/auth0-branding/disable-google-login.sh` (email/password only), or
   - **Full:** your own Google OAuth credentials in Auth0 (see below)
3. **Custom login URL (required for GTM)** — set up `login.ditto.jungle.win` so users never see
   `dev-…us.auth0.com`. Step-by-step: [custom-domain-setup.md](./custom-domain-setup.md).
4. The logo URL is pinned to a git commit and never breaks. To swap the logo, replace
   `public/shared/logo-gold.png`, push, update `LOGO_URL` in `apply.sh`, re-run it.

## User provisioning

No manual steps: the first time anyone logs in (email/password signup or Google), the app
creates their account row and a private workspace automatically (`src/authStore.ts`).

## Where to change login/signup copy

The text on the Auth0 Universal Login screens is **not** in the app UI — it lives in Auth0's
hosted login service. This repo keeps the canonical copy in:

- `custom-text-login.json` — headline, subtext, button labels on the login screen
- `custom-text-signup.json` — same for signup

**To update live production copy:**

1. Edit the JSON files in this folder (or paste the approved text below).
2. Run `auth0 login` then `bash docs/auth0-branding/apply.sh` — step 4/5 and 5/5 push the text.

**Or change it manually in the Auth0 dashboard:**

1. Open [Auth0 Dashboard](https://manage.auth0.com) → your tenant (`dev-rjdevt32s21vhh86`)
2. Go to **Branding** → **Universal Login** → **Advanced Options** → **Custom Text**
3. Select prompt **login** (or **signup**), language **English**
4. Edit `title` and `description`, then **Save**

Current recommended copy (also in the JSON files):

| Screen | Headline | Subtext |
| --- | --- | --- |
| Login | Log in to Ditto | Copy any Polymarket trader into your wallet. |
| Signup | Create your Ditto account | Pick traders to follow and connect your wallet. |
| Login alternate action | No account yet? | Sign up |

## Fix: Auth0 development keys

### What the warning means (plain language)

Auth0 gives every new account a **shared, temporary Google login** so you can test sign-in
without setting anything up. It works, but:

- Google may **rate-limit** logins (users see errors during busy periods)
- Auth0 shows a **"development keys"** warning in your dashboard
- It is **not appropriate for production** — you need your own Google app credentials

Nothing in the Ditto codebase controls this. The fix is entirely in **Google Cloud Console**
and the **Auth0 dashboard**.

### Which connection is affected

In this project, **Google** is the social connection using dev keys. Email/password uses Auth0's
built-in database and is not part of this warning.

### Step-by-step fix (Google OAuth)

1. **Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com))
   - Create or select a project (e.g. "Jungle Agents" or "Ditto")
   - **APIs & Services** → **OAuth consent screen** → configure (External, app name, support email)
   - **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**
   - Application type: **Web application**
   - **Authorized redirect URIs** — add exactly:
     ```
     https://dev-rjdevt32s21vhh86.us.auth0.com/login/callback
     ```
     (If you add a custom Auth0 domain later, Auth0 will show the correct callback URL on the
     Google connection settings page — use that instead.)
   - Copy the **Client ID** and **Client Secret**

2. **Auth0 Dashboard** → **Authentication** → **Social** → **Google**
   - Paste your **Client ID** and **Client Secret** (replace the dev-key placeholders)
   - Save

3. **Verify:** Auth0 dashboard warning should clear within a few minutes. Test incognito:
   `https://ditto.jungle.win` → Sign in with Google → no dev-keys banner on the Google screen.

### Alternative: hide Google login

If you do not need Google sign-in at launch:

1. Auth0 → **Authentication** → **Social** → **Google** → **Applications** tab
2. Disable the connection for the **Jungle Agents** application
3. Users sign in with email/password only; the dev-keys warning goes away

### Codebase changes required?

**None** for dev keys. The app only needs `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` for the
**Jungle Agents** Auth0 application (already in `.env`). Google OAuth credentials are stored
inside Auth0, not in this repo.
