# Traffic Checker

A static website that uses Google Maps to compare two places and show:

- **Time right now** with live traffic
- **Time after the jam clears** (free-flow, no traffic)
- **Extra time lost to the jam**, a traffic level (Clear / Light / Moderate / Heavy / Severe) and a delay meter
- A **forecast** for the next 3 hours: when the jam should ease and the best time to leave
- Alternative routes, a live traffic layer on the map, "leave at a set time", auto-refresh, and shareable links (`?from=...&to=...`)

No server needed. It runs entirely on GitHub Pages.

## 1. Get a Google Maps API key

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project with billing enabled.
2. Enable these APIs: **Maps JavaScript API** and **Routes API**.
3. Create an API key (APIs & Services > Credentials).
4. **Restrict the key** (important, because it is visible in the page source):
   - Application restriction: *Websites (HTTP referrers)*, add `https://YOUR-USERNAME.github.io/*`
   - API restriction: Maps JavaScript API and Routes API only
5. Set a budget alert and a daily quota cap on the project so a leaked key cannot run up a bill.

## 2. Deploy on GitHub Pages

1. Create a new GitHub repository and push these files to the `main` branch.
2. Repo **Settings > Pages > Build and deployment > Source: GitHub Actions**.
3. Repo **Settings > Secrets and variables > Actions > New repository secret**
   - Name: `GOOGLE_MAPS_API_KEY`
   - Value: your key
4. Push any commit (or run the workflow from the Actions tab). The site goes live at
   `https://YOUR-USERNAME.github.io/REPO-NAME/`.

The workflow copies the site into `_site/` and replaces the placeholder in `config.js` with your secret.

> **No secret set?** The site still works: it asks the visitor for their own key and keeps it in that browser's local storage only.

## Run locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. Without a baked-in key, paste your key into the box that appears. Add `http://localhost:8000/*` to the key's allowed referrers while testing.

## How it works

- `Route.computeRoutes()` from the Maps JavaScript API **Routes library**, with `routingPreference: TRAFFIC_AWARE_OPTIMAL`.
- `durationMillis` is the time with traffic. `staticDurationMillis` is the time with no traffic, which is used as "time after the jam clears".
- Delay = `durationMillis - staticDurationMillis`. Traffic level comes from the ratio of the two (under 1.1 is Clear, 1.1 to 1.25 Light, 1.25 to 1.5 Moderate, 1.5 to 2 Heavy, 2 or more Severe).
- The forecast calls the same API with future `departureTime` values (+15, +30, +60, +90, +120, +180 min).
- Colour-coded route and the live traffic layer come from `TRAFFIC_ON_POLYLINE` and `TrafficLayer`.

## Cost note

Each check makes 1 route request plus 6 forecast requests (auto-refresh only repeats the first one). Traffic-aware routing is a paid SKU, so check the current [Google Maps Platform pricing](https://mapsplatform.google.com/pricing/) and keep a quota cap on the key.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `style.css` | Styles (light and dark mode) |
| `app.js` | Maps loading, routing, traffic maths, rendering |
| `config.js` | API key placeholder replaced during deploy |
| `.github/workflows/deploy.yml` | GitHub Pages deployment |
