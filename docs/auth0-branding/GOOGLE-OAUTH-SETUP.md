# Google sign-in setup (production OAuth)

Use this when you want **Sign in with Google** back for Ditto / Jungle Agents **without** Auth0’s shared “development keys”.

**Time:** ~15 minutes once.  
**You must do:** Google Cloud Console (your Google account).  
**We automate:** Auth0 connection + re-enable for the Jungle Agents app (via script on the server).

---

## Part 1 — You do this in Google Cloud (one time)

### 1. Open Google Cloud Console

Go to [https://console.cloud.google.com](https://console.cloud.google.com) and sign in with the Google account you want to own the OAuth app (your business Google is best).

### 2. Create or pick a project

- Top bar → **Select a project** → **New project**
- Name: `Jungle Agents` (or `Ditto`)
- Click **Create**

### 3. Configure OAuth consent screen

1. **APIs & Services** → **OAuth consent screen**
2. User type: **External** → **Create**
3. Fill in:
   - **App name:** `Jungle Agents` (or `Ditto`)
   - **User support email:** your email
   - **Developer contact email:** your email
4. **Save and continue**
5. **Scopes:** leave defaults (email, profile, openid) → **Save and continue**
6. **Test users:** skip for now (you’ll publish later) → **Save and continue**

### 4. Create OAuth client credentials

1. **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Name: `Auth0 Ditto Login`
4. **Authorized redirect URIs** — add **exactly** this line (copy/paste):

   ```
   https://dev-rjdevt32s21vhh86.us.auth0.com/login/callback
   ```

   When you add the custom login domain later (`login.ditto.jungle.win`), also add:

   ```
   https://login.ditto.jungle.win/login/callback
   ```

5. Click **Create**
6. Copy and save somewhere safe (password manager):
   - **Client ID** (ends in `.apps.googleusercontent.com`)
   - **Client secret** (starts with `GOCSPX-`)

### 5. (Optional but recommended) Publish the app

While the consent screen is in **Testing**, only test users you add can sign in with Google.

Before public launch:

1. **OAuth consent screen** → **Publish app**
2. Complete Google verification if prompted (for basic email/profile scopes this is usually light)

---

## Part 2 — Run on the server (or any machine with `auth0 login`)

SSH to the server (or use a machine where you’ve run `auth0 login` against your tenant):

```bash
cd /opt/polymarket-bot-staging   # or your repo path
auth0 login                    # if not already logged in

export GOOGLE_OAUTH_CLIENT_ID="PASTE_CLIENT_ID_HERE"
export GOOGLE_OAUTH_CLIENT_SECRET="PASTE_CLIENT_SECRET_HERE"

bash docs/auth0-branding/configure-google-oauth.sh
```

This script:

1. Saves your Google Client ID + Secret into Auth0 (Social → Google)
2. Re-enables Google for the **Jungle Agents** application

**Do not commit the secret to git.** Only pass it via environment variables or paste in the Auth0 dashboard manually.

### Manual alternative (Auth0 dashboard)

If you prefer the UI:

1. [Auth0 Dashboard](https://manage.auth0.com) → **Authentication** → **Social** → **Google**
2. Paste **Client ID** and **Client Secret** (replace dev keys)
3. **Applications** tab → enable **Jungle Agents**
4. Save

---

## Part 3 — Verify

1. Auth0 → **Alerts** → “development keys” warning should clear within a few minutes
2. Incognito window → [https://ditto.jungle.win](https://ditto.jungle.win) → **Sign in with Google**
3. Log in as a user who previously used Google — they should see **the same workspace** (same `google-oauth2|…` account)

---

## What I cannot do for you

| Step | Why |
|------|-----|
| Create the Google Cloud project | Requires **your** Google account login |
| Generate Client ID / Secret | Only Google Cloud can issue these |
| Publish OAuth consent screen | Your Google Cloud project, your decision |

Everything on **Auth0** after you have the two strings is automated by `configure-google-oauth.sh`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `redirect_uri_mismatch` | Redirect URI in Google must match Auth0 callback **exactly** (see step 4 above) |
| Google button missing | Run `configure-google-oauth.sh` or enable Jungle Agents on Google connection |
| “Access blocked: app not verified” | Add yourself as test user, or publish OAuth consent screen |
| User gets a **new empty** account | They signed up with email instead of Google — use Auth0 account linking (see prior chat) |
