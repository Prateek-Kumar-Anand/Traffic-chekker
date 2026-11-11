# Traffic Checker

Sign in, enter two places, and see:

- **Time right now** with live traffic
- **Time after the jam clears** (free-flow, no traffic)
- **Extra time lost to the jam**, a traffic level and a delay meter
- A **forecast** for the next 3 hours and the best time to leave
- Alternative routes, "leave at a set time", auto-refresh

**Nobody can use it without signing in.** There are two kinds of login:

| | Who | What they get |
| --- | --- | --- |
| **User** | Anyone with a Google account, or an email and password (email must be confirmed) | The traffic checker |
| **Admin** | The emails you list in `ADMIN_EMAILS` | The traffic checker **plus** the admin console: service status, Google lookups used today, everyone who has signed in, and Block / Unblock |

The interface is white. Colour is only used for traffic (green, amber, red).

## How it is put together

```
Browser (GitHub Pages)  --login token-->  Backend (Render)  --Maps key-->  Google Routes API
  Firebase sign-in                          checks the token and the role,
  User / Admin tabs                         keeps the Maps key, MongoDB:
                                            cache, limits, people list, blocks
```

- The **Google Maps key is only on the backend.** It is never in the website.
- Every request carries a Firebase login token. The backend verifies it itself (signature, expiry, project, confirmed email). Without a valid login the answer is `401`.
- **Roles are decided by the backend**, from the confirmed email in the token matched against `ADMIN_EMAILS`. The Admin tab on the website is only a door; the admin endpoints refuse everyone else (`403`), so editing the page in the browser gives nothing.
- A blocked person is refused on their very next request, even while their login is still valid. Admins can never be blocked.
- Limits per IP address and per account, plus a daily cap on Google calls.
- The backend stores, for each person who signs in: their id, email, last-active time, number of checks and blocked flag (so the admin console works). Routes people search for are **not** stored on the server; saved and recent routes stay in each person's own browser.

## It always deploys, and says what is missing

Nothing below can make a deploy fail just because a setting is missing:

| Missing | What happens |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` on the backend | Backend runs. Checking traffic pops up **"API not connected at the backend"**. The admin console shows Google Maps API: Not connected, with the fix. |
| Backend not running or `API_BASE_URL` not set | The same popup ("the backend cannot be reached" / "no backend address"). |
| Firebase settings on the website | The site deploys but is locked: the sign-in page says "Sign-in is not set up yet", so nobody can use it. |

A setting that is present but malformed (or only some of the four Firebase settings) does stop the build, because that is a mistake worth catching.

## Set up (in this order)

### 1. MongoDB

Create a free MongoDB Atlas cluster and a database user that can only read/write one database. Copy its connection string.

### 2. Firebase sign-in

1. Open the [Firebase console](https://console.firebase.google.com/) and create a project.
2. **Build > Authentication > Get started > Sign-in method**: turn on **Google** and **Email/Password**.
3. **Authentication > Settings > Authorized domains**: add `YOUR-USERNAME.github.io`.
4. **Project settings > General > Your apps > Add app > Web (`</>`)**. Copy `apiKey`, `authDomain`, `projectId`, `appId`.

The Firebase `apiKey` is **not** the Maps key. It is a public identifier for the sign-in service and is meant to be in the page.

### 3. Deploy the backend (Render)

1. Create a Render *Blueprint* from this repo (`render.yaml`).
2. In the Render dashboard set:

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | connection string from step 1 |
| `FIREBASE_PROJECT_ID` | `projectId` from step 2 |
| `ALLOWED_ORIGINS` | `https://YOUR-USERNAME.github.io` (no path, no trailing slash) |
| `ADMIN_EMAILS` | your email, e.g. `you@gmail.com` (comma-separate several) |
| `GOOGLE_MAPS_API_KEY` | optional for now, see step 4 |

3. Note the backend address, e.g. `https://traffic-checker-api.onrender.com`.

### 4. Google Maps key (backend only)

1. In the [Google Cloud Console](https://console.cloud.google.com/) pick a project with billing enabled and enable **Routes API** only.
2. Create an API key and restrict it to **Routes API**. Set a budget alert and a daily quota.
3. Add it to the backend as `GOOGLE_MAPS_API_KEY` and redeploy. The popup disappears and traffic checks work.

### 5. Deploy the website (GitHub Pages)

1. Repo **Settings > Pages > Build and deployment > Source: GitHub Actions**.
2. Repo **Settings > Secrets and variables > Actions > New repository secret**, add:

| Secret | Value |
| --- | --- |
| `API_BASE_URL` | backend address from step 3 |
| `FIREBASE_API_KEY` | `apiKey` from step 2 |
| `FIREBASE_AUTH_DOMAIN` | `authDomain` from step 2 |
| `FIREBASE_PROJECT_ID` | `projectId` from step 2 |
| `FIREBASE_APP_ID` | `appId` from step 2 |

3. Push to `main` (or run the workflow from the Actions tab). The site goes live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.

Never add `GOOGLE_MAPS_API_KEY` to GitHub. The build refuses to run if it is present, and fails if any Google key other than the Firebase one ends up in the page.

### 6. Become the admin

Open the site, choose the **Admin** tab and sign in with the Google account (or confirmed email and password) whose address is in `ADMIN_EMAILS`. You land in the admin console. Other people use the **User** tab.

Matching is by the confirmed email, ignoring upper/lower case. A new admin only needs their email added to `ADMIN_EMAILS` and the backend restarted.

## Run locally

```bash
# backend (Node 22+; needs a MongoDB URI)
cd server && cp .env.example .env     # fill it in, then:
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

Covers login-token checking (forged, expired, wrong project, `alg: none`, unconfirmed email, key rotation), roles, admin endpoints, blocking, "API not connected", input validation, CORS, rate limits, spend cap, caching and that the Maps key never appears in any response or log.

## If something does not work

- **Popup "API not connected at the backend"**: the backend has no (or a rejected) `GOOGLE_MAPS_API_KEY`, cannot be reached, or `API_BASE_URL` is missing. The popup text says which.
- **"Sign-in is not set up yet"**: the five GitHub secrets (or at least the four Firebase ones) are missing; deploy again after adding them.
- **"This website's address is not authorised"**: add the domain under Firebase > Authentication > Settings > Authorized domains.
- **"This account is not an administrator"**: the email is not in `ADMIN_EMAILS` (or the backend was not restarted after you added it).
- **Every check says "session has ended"**: the backend's `FIREBASE_PROJECT_ID` must equal the website's `FIREBASE_PROJECT_ID`.
- **Google pop-up blocked or does nothing**: open the browser console. The strict Content-Security-Policy in `site/index.html` may need an extra origin if you enable more Firebase features (for example reCAPTCHA protection).
- **First request after a quiet period is slow**: free Render services sleep; the popup "cannot be reached" can appear once while it wakes. Wait a minute and try again.

## Files

| Path | Purpose |
| --- | --- |
| `site/index.html`, `style.css` | White interface: sign-in (User / Admin), confirm email, traffic checker, admin console, popup |
| `site/auth.js` | Firebase sign-in (the only file that talks to Firebase) |
| `site/app.js` | Roles, checks, admin console, saved routes |
| `site/config.js` | Placeholders for public settings, filled in at build time |
| `scripts/build-site.mjs` | Builds `_site/` and runs the secret scan |
| `server/` | Backend: token and role checks, Maps calls, cache, limits, people list |
| `.github/workflows/` | CI tests and GitHub Pages deploy |
| `render.yaml` | Backend deployment blueprint |
