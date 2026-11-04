# Traffic Checker (secured version)

Enter two places and see: the **traffic level**, the **drive time right now**, the **drive time after the jam clears**, the **minutes lost to the jam**, a 3-hour **forecast**, alternative routes, and a colour-coded route drawing.

```
 Browser (GitHub Pages, static)            Backend (Node, any host)              Services
 ─────────────────────────────            ─────────────────────────             ───────────────
 index.html / app.js / style.css  ──POST──▶ validate → rate-limit → cache ──▶   Google Routes API
 no keys, no third-party scripts           holds the Google key                  (key stays here)
 saves YOUR recent/saved routes            caps daily spend            ◀──▶     MongoDB Atlas
 in localStorage (this browser only)       sanitises everything                  cache, limits, quota
```

**GitHub Pages can only serve static files**, so the backend runs somewhere else (Render, Fly, Railway, a VPS…) and the page calls it. MongoDB (Atlas) sits behind the backend, never in front of the browser.

## What was wrong, and what fixes it

| Problem in the first version | Fix |
| --- | --- |
| Google API key was in the page source (or typed into a box and kept in the browser). Anyone could copy it and run up your bill. | The key exists only on the backend, sent to Google in a header. The built site is scanned and **the build fails** if it contains a key, a Mongo URI or a secret variable name. |
| No limit on use: one script could burn the whole Google quota. | Per-client limits (10/min, 100/hour by default), a **hard daily cap** on Google calls enforced atomically in MongoDB, and a 2-minute cache so repeat checks cost nothing. |
| Google's scripts were loaded into the page; a compromise there ran with full page rights. | No third-party scripts at all. The route is drawn as inline SVG; the full street map opens in Google Maps through a link. |
| No Content Security Policy. | Strict CSP: only own scripts/styles, no inline code, no `eval`, network calls only to the backend, no framing of forms. Tested in a real browser. |
| HTML strings built from route text (`innerHTML`) = XSS risk. | All UI built with DOM nodes and `textContent`. Script tags in a place name are displayed as text. |
| Anything in browser storage was trusted. | Stored data is re-validated on load (types, lengths, junk dropped); corrupt data is ignored. "Clear my saved data" wipes it. |
| Shared links auto-ran searches from the URL. | Removed. Places are never put in the URL. |
| Deploy script pasted the secret into files with `sed`. | No secret in the site build at all; workflow has least-privilege permissions and doesn't persist git credentials. |
| Backend input (once there is one) is the classic NoSQL-injection and abuse target. | Strict schema (unknown fields rejected, only strings/booleans), 2 KB body limit, control characters rejected. User text is **hashed** before it reaches MongoDB, and every key is pattern-checked, so it can never become a query operator. |
| Any website could call the API from a visitor's browser. | CORS allowlist with exact origin match (no `*`, no credentials). Calls with no `Origin` are refused by default. |
| Errors could leak internals. | Generic error messages; Google's error text is never forwarded; the key is redacted from logs; logs hold no places, query strings or IP addresses. |
| Database outage could let requests slip past the limiter. | **Fails closed**: if MongoDB is unreachable, the API answers 503 and never calls Google. |

### Where your data lives

- **In the browser only:** your recent and saved routes (`localStorage`, key `trafficChecker.v2`) and the auto-refresh setting. They are never sent to the server for storage.
- **In MongoDB (all expire by themselves):** cached route results keyed by a SHA-256 hash (2 min), rate-limit counters keyed by an HMAC of the IP (about an hour), and one daily counter of Google calls. No names, addresses or raw IPs are stored.

## Setup

### 1. Google key
Google Cloud Console → enable **Routes API** only → create a key → *API restrictions*: Routes API only. Set a **budget alert** and a **daily quota cap** on the project. (The key is server-side, so a website referrer restriction is not needed; use an IP restriction if your host has a fixed IP.)

### 2. MongoDB Atlas
Create a free cluster → *Database Access*: a user with **readWrite on the `trafficchecker` database only** and a long random password → *Network Access*: add your host's IP. Hosts like Render have no fixed IP, so you will probably need `0.0.0.0/0`; that is acceptable only because the user is least-privilege, the password is strong and Atlas enforces TLS. Copy the connection string.

### 3. Deploy the backend (Render example)
Push the repo to GitHub, then Render → *New → Blueprint* (uses `render.yaml`) and fill in:

| Variable | Value |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | your key |
| `MONGODB_URI` | the Atlas string |
| `ALLOWED_ORIGINS` | `https://YOUR-USERNAME.github.io` (origin only: no path, no trailing slash) |
| `IP_HASH_SECRET` | generated for you (32+ random chars) |
| `TRUST_PROXY_HOPS` | `1` on Render |

The backend refuses to start if a secret is missing or weak. Check `https://YOUR-API/healthz`. Any host that runs a Docker image works (`server/Dockerfile`, runs as a non-root user); see `server/.env.example` for every setting.

Run `npm install` once inside `server/` and **commit `server/package-lock.json`**, so installs are reproducible and the weekly audit has something to check.

### 4. Deploy the site
Repo → *Settings → Pages → Source: GitHub Actions*. Then *Settings → Secrets and variables → Actions → **Variables** → New repository variable*: `API_BASE_URL` = your backend origin (e.g. `https://traffic-checker-api.onrender.com`). It is a public address, not a secret. Push to `main`; the workflow builds and publishes.

## Run locally
```bash
cd server && cp .env.example .env     # fill it in; set ALLOWED_ORIGINS=http://localhost:8000
export $(grep -v '^#' .env | xargs) && npm install && npm start
# another terminal, from the repo root:
API_BASE_URL=http://localhost:8080 node scripts/build-site.mjs
python3 -m http.server 8000 --directory _site
```

## Tests
```bash
npm test                                   # 38 backend tests, no packages needed
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test   # also runs the same store checks against a real MongoDB
```
Covered: injection payloads, oversized/chunked/malformed bodies, CORS and origin rules, rate limits (including spoofed `X-Forwarded-For`), daily quota under concurrency, caching, error and key leakage, fail-closed behaviour, Google response sanitising, config validation.

## Honest limits
- **Not run against a real MongoDB or the real Google API in development** (no network access to them there). The MongoDB store is covered by a shared test contract that passes on the in-memory store and runs against a real database when `MONGODB_TEST_URI` is set; run it once before going live. The Dockerfile and `render.yaml` were not built or deployed in development either.
- **CORS is not authentication.** A script outside a browser can still call the API; the rate limit and daily cap are what bound the damage. If the daily cap is reached, the site pauses until the next UTC day, which is the trade-off for a bounded bill.
- GitHub Pages cannot send HTTP headers, so the CSP is a `<meta>` tag. That cannot include `frame-ancestors`, so the page itself can be framed; it holds no accounts or sensitive actions.
- GitHub Actions are pinned to major versions, not commit hashes; Dependabot is configured to keep them current.
- The route drawing is schematic (no street basemap), by design, to avoid third-party scripts.
- Each check with forecast makes up to 7 Google requests (cached for 2 minutes). Traffic-aware routing is a paid Google product; check current pricing.

## Files
| Path | Purpose |
| --- | --- |
| `site/` | The static website |
| `scripts/build-site.mjs` | Builds `_site/`, sets the backend address, scans for secrets |
| `server/src/` | Backend: `app.js` (HTTP, limits, CORS), `validate.js`, `google.js`, `store-mongo.js`, `store-memory.js`, `config.js` |
| `server/test/` | Backend tests |
| `.github/workflows/` | `deploy.yml` (Pages), `ci.yml` (tests, build, dependency audit) |
| `render.yaml`, `server/Dockerfile` | Backend hosting |
