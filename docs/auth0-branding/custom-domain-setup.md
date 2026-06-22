# Auth0 custom domain — clean login URL

## Why the URL looks “sketchy” today

When you click **Log in**, the browser leaves `ditto.jungle.win` and goes to Auth0’s hosted login page. Right now that page lives at:

```
https://dev-rjdevt32s21vhh86.us.auth0.com/...
```

That is Auth0’s **default tenant hostname**. Every new Auth0 account gets one. It is normal for development, but **not** what users expect from a production product. Sites like Notion, Linear, and Vercel use the same Auth0 pattern — they just hide it behind a **custom domain**.

## What production sites do

| Pattern | Example | Ditto target |
| --- | --- | --- |
| App stays on product domain | `app.notion.so` | `ditto.jungle.win` (already correct) |
| Login on branded auth subdomain | `auth.notion.so`, `login.linear.app` | **`login.ditto.jungle.win`** (recommended) |
| Ugly default (dev only) | `dev-xxxx.us.auth0.com` | what you have now — **GTM blocker** |

Users never stay on `ditto.jungle.win/login` for the password form — OIDC redirects to Auth0. The fix is **not** a `/login` page on the app; it is a **custom Auth0 domain** that looks like yours.

## Setup checklist

### 1. Auth0 — create custom domain

1. [Auth0 Dashboard](https://manage.auth0.com) → **Settings** → **Advanced** → ensure custom domains are available (may require a card on file for Free tier — not charged).
2. **Branding** → **Custom Domains** → **Add Domain**
3. Domain: `login.ditto.jungle.win`
4. Type: **Auth0-managed certificates** (simplest)
5. Copy the **CNAME** target Auth0 gives you (e.g. `xxxx.edge.tenants.us.auth0.com`)

### 2. DNS — add CNAME

At whoever hosts `jungle.win` DNS:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `login.ditto` | *(paste Auth0 CNAME target)* |

Wait for propagation (often 5–30 minutes).

### 3. Auth0 — verify and set default

1. Back in Auth0 → **Verify** the domain
2. Set **`login.ditto.jungle.win`** as the **default** custom domain

### 4. Production server — update env

```env
AUTH0_ISSUER_BASE_URL=https://login.ditto.jungle.win
AUTH0_BASE_URL=https://ditto.jungle.win
# AUTH0_EXPECTED_TENANT unset when using custom domain
```

Restart the app service.

### 5. Auth0 application — callbacks (unchanged)

These stay on the **app** domain, not the login domain:

- `https://ditto.jungle.win/auth/callback`
- `http://localhost:3000/auth/callback` (dev)

### 6. Google OAuth (if enabled)

If you use Google sign-in with your **own** OAuth app, update Google Cloud **Authorized redirect URI** to:

```
https://login.ditto.jungle.win/login/callback
```

(Auth0 shows the exact URI on **Authentication → Social → Google**.)

### 7. Smoke test

1. Incognito → `https://ditto.jungle.win`
2. Click log in
3. Address bar should show **`login.ditto.jungle.win`**, not `dev-….us.auth0.com`
4. Complete login → return to `ditto.jungle.win`

## CLI shortcut (after `auth0 login`)

```bash
auth0 api post "custom-domains" --data '{
  "domain": "login.ditto.jungle.win",
  "type": "auth0_managed_certs"
}'
```

Then add the CNAME from the response, verify in the dashboard, update `.env`, restart.
