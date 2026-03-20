# VPS comparison and DNS/TLS checklist (hosted bot)

This note supports **Phase 0 — Egress and Hosting** on the execution board: pick a server, point your domain at it, and serve the dashboard over HTTPS without surprises.

**Always verify pricing and limits on the provider’s own site** before you buy—numbers below are approximate and change.

---

## What this project needs from a VPS

| Requirement | Why it matters |
|-------------|----------------|
| **Linux VM with root (SSH)** | Run Node.js or Docker the way the [Dockerfile](../../Dockerfile) expects |
| **Stable public IPv4** | DNS `A` record for your domain; APIs and webhooks see a consistent address |
| **Outbound HTTPS** | Talk to Polymarket (Data API, CLOB, Gamma), Polygon RPC, optional third-party feeds |
| **Always-on process** | Copy-trading and discovery are long-running; not a good fit for “serverless only” |
| **Enough RAM** | **≥ 2 GB** comfortable for Node + SQLite + occasional spikes; **4 GB** is a relaxed default |
| **Region** | EU (e.g. Germany/Finland) matches the board’s “EU VPS” direction and GDPR-friendly hosting |

Nice-to-have: snapshots/backups, simple firewall UI, predictable monthly bill.

---

## Provider comparison (shortlist)

### Hetzner Cloud (Germany / Finland — EU)

- **Fit:** Strong default for this repo’s plan: **low cost**, **large included transfer** on many plans, EU regions, full root, Docker-friendly.
- **IPv4:** Cloud servers normally include a **primary IPv4**; you can also use **floating** IPs for failover (extra monthly fee—check [Hetzner docs on Primary IPs](https://docs.hetzner.com/cloud/servers/primary-ips/overview)). For a single bot VM, the included primary IPv4 is usually enough.
- **Caveats:** Stock on popular instance types can be tight at times; UI is “engineer-simple,” not hand-holding.
- **Rough ballpark:** Entry **cost-optimized** EU instances are often in the **~€3.5–6/mo** range before VAT—**confirm on [hetzner.com/cloud](https://www.hetzner.com/cloud)**.

### DigitalOcean (Droplets)

- **Fit:** Very familiar to developers; docs and UX are excellent; EU regions available.
- **IPv4:** Droplets get a public IPv4; **reserved IPv4** while not attached to a droplet is billed (see [DO reserved IP pricing](https://docs.digitalocean.com/products/networking/reserved-ips/details/pricing/))—for one server you typically **don’t** need a separate reserved IP.
- **Caveats:** Usually **more expensive per CPU/RAM** than Hetzner for similar specs.
- **Rough ballpark:** Small general-purpose droplets often start around **~$4–12/mo** depending on size—**confirm on [digitalocean.com/pricing](https://www.digitalocean.com/pricing)**.

### OVHcloud (VPS / Public Cloud)

- **Fit:** Large EU provider; good if you already use OVH for domains or compliance preferences.
- **Caveats:** Product lines (VPS vs Public Cloud) can feel fragmented; support and UX vary by product. Compare **onboarding time** vs Hetzner/DO if you’re new to OVH.
- **Rough ballpark:** Use **[ovhcloud.com](https://www.ovhcloud.com/)** pricing pages for your country.

### Honorable mentions

- **Vultr / Linode (Akamai):** Similar to DO—simple VMs, global regions; compare price vs Hetzner for EU.
- **Oracle Cloud “Always Free”:** Can be extremely cheap/free but **eligibility, quotas, and UX** trip people up—fine for experiments, not always the fastest path to “production bot tonight.”

### Practical recommendation for *this* project

1. **Default path:** **Hetzner Cloud, EU location (Falkenstein or Helsinki), 2 vCPU / 4 GB RAM class**, Ubuntu LTS, primary IPv4 included—matches the board and keeps cost low.
2. **Pick DigitalOcean instead if** you value hand-holding and tutorials over lowest monthly price.
3. **Pick OVH instead if** you already standardize on OVH or have billing/support reasons.

---

## DNS checklist (your domain → the VPS)

Do this **after** the VPS exists and you know its **public IPv4** (and optionally IPv6).

1. **Choose hostnames**
   - **Root / apex:** `example.com` (often `A` record).
   - **Optional:** `www.example.com` (`CNAME` to apex or separate `A` record—your registrar may prefer **CNAME flattening** / ALIAS for apex—follow their docs).

2. **Create records at your DNS host (registrar or Cloudflare, etc.)**
   - **`A` record:** `example.com` → **VPS IPv4**. TTL: **300–3600 s** (lower while testing, raise later).
   - **`AAAA` (optional):** Only if your VPS has IPv6 **and** your reverse proxy/listener is configured for it.
   - **Remove or avoid conflicts:** Old `A` records pointing at parking pages or previous servers.

3. **Wait for propagation**
   - Use `dig example.com A +short` or an online DNS checker from multiple regions. Changes can take **minutes to hours**.

4. **Bot-specific note**
   - The app listens on **`PORT` (default 3001)** per [ENV_EXAMPLE.txt](../../ENV_EXAMPLE.txt). Browsers use **443** via a reverse proxy (below)—you do **not** expose `3001` publicly unless you intend to.

---

## TLS (HTTPS) checklist

Goal: visitors hit **`https://example.com`**, and the proxy forwards to **`http://127.0.0.1:3001`** (or your Docker publish port).

### Before you start

- [ ] DNS `A` record resolves to this server from the public internet.
- [ ] Firewall allows **TCP 22** (SSH), **80** (HTTP challenge / redirect), **443** (HTTPS). **Do not** open `3001` to the world unless you have a reason.

### Option A — Caddy (simple automatic HTTPS)

- [ ] Install Caddy on the VPS.
- [ ] Site block: `reverse_proxy 127.0.0.1:3001` (or Docker bridge IP/port).
- [ ] Let Caddy obtain and renew Let’s Encrypt certificates (needs port **80** reachable).

### Option B — Nginx + Certbot

- [ ] Install Nginx + Certbot (e.g. `python3-certbot-nginx` on Ubuntu).
- [ ] Server block `proxy_pass http://127.0.0.1:3001;` with usual headers.
- [ ] Run Certbot to install certificates and renewal hooks.

### After HTTPS works

- [ ] Visit `https://example.com` — dashboard loads without certificate warnings.
- [ ] Set **`API_SECRET`** in production `.env` so the API is not open (see open PR / merge plan for optional auth).
- [ ] Optional: HTTP → HTTPS redirect only (force TLS).

---

## Quick verification (egress)

Run the automated check from the repo (after `npm install`):

```bash
npm run validate:egress
```

See [Egress validation plan](../plans/egress-validation.md) for what it tests (geoblock, CLOB, Gamma, Data API, Polygon RPC).

---

## Sources and ongoing updates

- Hetzner Cloud and Primary IP docs: [docs.hetzner.com](https://docs.hetzner.com/)
- DigitalOcean reserved IP pricing: [docs.digitalocean.com](https://docs.digitalocean.com/products/networking/reserved-ips/details/pricing/)
- Re-check **instance names and monthly caps** on the official pricing pages before provisioning.

When you change provider or region, update this file in the same PR as any `README` / deployment notes so the next person (or agent) does not rely on stale numbers.
