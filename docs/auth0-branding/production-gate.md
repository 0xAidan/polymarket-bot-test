# Auth0 production gate (GTM blockers)

Use this before calling Ditto public-ready. These are **dashboard / DNS / env** changes — not app code.

## Dev Keys alert — is it fixed?

| Who sees it? | What it is | Fixed in code? |
| --- | --- | --- |
| **You** (Auth0 tenant admin) | Dashboard warning under **Alerts** | No — Auth0 dashboard only |
| **End users** | They do **not** see this alert | N/A |

The alert means **Google sign-in** is still using Auth0’s shared test OAuth app. Users might see a Google “unverified app” screen during Google login — that *is* user-facing and unprofessional.

### Fix (pick one before launch)

**A. Launch without Google (fastest)** — email/password only:

```bash
auth0 login
bash docs/auth0-branding/disable-google-login.sh
```

**B. Production Google login** — your own Google Cloud OAuth app pasted into Auth0 → Social → Google. See [README.md](./README.md#fix-auth0-development-keys).

Until A or B is done, **the dev-keys alert is not resolved**.

---

## Clean login URL — is it fixed?

| State | URL users see when logging in | GTM OK? |
| --- | --- | --- |
| Now | `dev-rjdevt32s21vhh86.us.auth0.com` | **No** |
| Target | `login.ditto.jungle.win` | **Yes** |

Follow [custom-domain-setup.md](./custom-domain-setup.md). This requires DNS access for `jungle.win`.

`ditto.jungle.win/login` is **not** how OIDC works — the app redirects to Auth0. A branded **subdomain** is the industry-standard fix.

---

## Branding & copy — is it live?

Repo copy in `custom-text-*.json` does **not** change production until:

```bash
auth0 login
bash docs/auth0-branding/apply.sh
```

Verify incognito: headline should be **“Log in to copy Jungle Agents”**.

---

## One-command pre-launch sequence

```bash
auth0 login

# 1. Push branded copy
bash docs/auth0-branding/apply.sh

# 2. Remove Google dev keys (or set real Google OAuth first — see README)
bash docs/auth0-branding/disable-google-login.sh

# 3. Custom domain — manual DNS step, then update server .env:
#    AUTH0_ISSUER_BASE_URL=https://login.ditto.jungle.win
#    sudo systemctl restart polymarket-app.service
```

---

## Production readiness checklist

- [ ] Custom domain verified; login URL is `login.ditto.jungle.win`
- [ ] `apply.sh` run; login copy matches repo
- [ ] Dev-keys alert cleared (Google disabled **or** real Google OAuth)
- [ ] Incognito login → logout → login works
- [ ] No `dev-….us.auth0.com` visible to users
- [ ] `PLATFORM_ADMIN_EMAILS` set to real admins only
- [ ] `AUTH_SESSION_SECRET` is 64+ random chars on production server

See also [gtm-launch-checklist.md](../ops/gtm-launch-checklist.md).
