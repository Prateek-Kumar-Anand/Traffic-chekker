# Traffic Checker

Sign in, enter two places, and see:

- **Time right now** with live traffic
- **Time after the jam clears** (free-flow, no traffic)
- **Extra time lost to the jam**, a traffic level (Clear / Light / Moderate / Heavy / Severe) and a delay meter
- A **forecast** for the next 3 hours: when the jam should ease and the best time to leave
- Alternative routes, a route drawing coloured by traffic, "leave at a set time", auto-refresh

## How it is put together

```
Browser (GitHub Pages, white UI)  --login token-->  Backend (Render)  --Maps key-->  Google Routes API
   Firebase sign-in                                  checks the token,                  MongoDB: cache,
   (Google or email)                                 holds the Maps key                 rate limits, spend cap
```

- **The Google Maps key is never in the website.** Only the backend has it, and the backend only uses it for people who are signed in.
- **Sign-in is Firebase Authentication** (Google, or email and password with email confirmation).
- The backend verifies every request's Firebase token itself (signature, expiry, project, confirmed email) before it spends anything. Without a valid login, the API answers `401`.
- Limits still apply per IP address *and* per account, plus a hard daily cap on Google calls.
- Saved and recent routes stay in the visitor's own browser, separately for each account.

> The website files are public on GitHub Pages, so the sign-in screen in the browser is not what protects the app. The backend refusing anonymous requests is.

## Set up (in this order)

### 1. Google Maps key (backend only)

1. In the [Google Cloud Console](https://console.cloud.google.com/), pick a project with billing enabled.
2. Enable **Routes API** only.
3. Create an API key and restrict it to **Routes API**. Do **not** add it anywhere on GitHub except the backend host.
4. Set a budget alert and a daily quota cap on the project.

### 2. MongoDB

Create a free MongoDB Atlas cluster and a database user that can only read/write one database. Copy its connection string.

### 3. Deploy the backend (Render)

1. Create a Render *Blueprint* from this repo (`render.yaml`).
2. Set these environment variables in the Render dashboard (they are secrets and never go in the repo):

| Variable | Value |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | the key from step 1 |
| `MONGODB_URI` | the connection string from step 2 |
| `ALLOWED_ORIGINS` | `https://YOUR-USERNAME.github.io` (no path, no trailing slash) |
| `FIREBASE_PROJECT_ID` | filled in during step 4 |

3. Note the backend address, e.g. `https://traffic-checker-api.onrender.com`.

### 4. Firebase sign-in (do this last)

1. Open the [Firebase console](https://console.firebase.google.com/) and create a project (or use your Google Cloud project).
2. **Build > Authentication > Get started > Sign-in method**: turn on **Google** and **Email/Password**.
3. **Authentication > Settings > Authorized domains**: add `YOUR-USERNAME.github.io`.
4. **Project settings > General > Your apps > Add app > Web (`</>`)**. Copy the config it shows: `apiKey`, `authDomain`, `projectId`, `appId`.
5. Put the `projectId` into the backend's `FIREBASE_PROJECT_ID` (step 3) and redeploy it.

The Firebase `apiKey` is **not** the Maps key. It is a public identifier for the sign-in service and is meant to be in the page; the Maps key is the one that stays hidden. Do not reuse your Maps key here.

### 5. Deploy the website (GitHub Pages)

1. Repo **Settings > Pages > Build and deployment > Source: GitHub Actions**.
2. Repo **Settings > Secrets and variables > Actions > New repository secret**, add all five:

| Secret | Value |
| --- | --- |
| `API_BASE_URL` | backend address from step 3 |
| `FIREBASE_API_KEY` | `apiKey` from step 4 |
| `FIREBASE_AUTH_DOMAIN` | `authDomain` from step 4 |
| `FIREBASE_PROJECT_ID` | `projectId` from step 4 |
| `FIREBASE_APP_ID` | `appId` from step 4 |

3. Push to `main` (or run the workflow from the Actions tab). The site goes live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.

Do **not** add `GOOGLE_MAPS_API_KEY` to GitHub. The build refuses to run if it finds it, and it also fails if any Google API key other than the Firebase one ends up in the page.

## Run locally

```bash
# backend (needs Node 22+; uses an in-memory store only in tests, so a MongoDB URI is required)
cd server && cp .env.example .env   # fill it in, then:
node --env-file=.env src/index.js

# website
API_BASE_URL=http://localhost:8080 FIREBASE_API_KEY=... FIREBASE_AUTH_DOMAIN=... \
FIREBASE_PROJECT_ID=... FIREBASE_APP_ID=... node scripts/build-site.mjs
python3 -m http.server 8000 --directory _site
```

Add `http://localhost:8000` to `ALLOWED_ORIGINS` and `localhost` to Firebase's authorized domains while testing.

## Tests

```bash
npm test
```

Covers token checking (forged, expired, wrong project, `alg: none`, unconfirmed email, certificate rotation), input validation, CORS, rate limits, spend cap, caching and that the Maps key never appears in any response or log.

## If sign-in does not work

- **"This website's address is not authorised"**: add the site's domain under Firebase > Authentication > Settings > Authorized domains.
- **Google pop-up is blocked or does nothing**: open the browser console. The site ships with a strict Content-Security-Policy in `site/index.html`; if you turn on extra Firebase features (for example reCAPTCHA protection), add the origins it reports.
- **Signed in but every check fails with "session has ended"**: the backend's `FIREBASE_PROJECT_ID` must match the website's `FIREBASE_PROJECT_ID`.
- **"Confirm your email address first"**: email/password accounts must click the link in the confirmation email. Google accounts are confirmed already.

## Files

| Path | Purpose |
| --- | --- |
| `site/index.html`, `style.css` | The white interface: sign-in, confirm-email and app views |
| `site/auth.js` | Firebase sign-in (the only file that talks to Firebase) |
| `site/app.js` | Checks, rendering, saved routes |
| `site/config.js` | Placeholders for public settings, filled in at build time |
| `scripts/build-site.mjs` | Builds `_site/` and runs the secret scan |
| `server/` | Backend: token check, Maps calls, cache, limits |
| `.github/workflows/` | CI tests and GitHub Pages deploy |
| `render.yaml` | Backend deployment blueprint |
