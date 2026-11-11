// Server-side client for the Google Routes API (computeRoutes).
// The API key lives only here, in a request header, and is never returned or logged.
// Everything coming back from Google is re-validated before it reaches a browser.

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const MAX_RESPONSE_CHARS = 2_000_000;

const FULL_MASK = [
  "routes.duration",
  "routes.staticDuration",
  "routes.distanceMeters",
  "routes.description",
  "routes.polyline.encodedPolyline",
  "routes.travelAdvisory.speedReadingIntervals",
].join(",");
const LIGHT_MASK = "routes.duration,routes.staticDuration";

export class GoogleError extends Error {
  // kind: "no_route" | "upstream_auth" | "upstream_busy" | "upstream_error"
  constructor(kind, status, detail) {
    super(`google ${kind} (http ${status})${detail ? ": " + detail : ""}`);
    this.kind = kind;
    this.status = status;
  }
}

function waypoint(p) {
  return p.kind === "coords"
    ? { location: { latLng: { latitude: p.lat, longitude: p.lng } } }
    : { address: p.text };
}

function parseSeconds(v) {
  if (typeof v !== "string" || !/^\d{1,9}(?:\.\d{1,9})?s$/.test(v)) return null;
  return Math.round(parseFloat(v));
}

const SPEED = { NORMAL: 0, SLOW: 1, TRAFFIC_JAM: 2 };

function cleanIndex(v, def) {
  if (v === undefined) return def; // protobuf JSON omits zero values
  return Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null;
}

export function sanitizeRoute(r) {
  if (!r || typeof r !== "object") return null;
  const durationSec = parseSeconds(r.duration);
  if (durationSec === null) return null;
  const staticSec = parseSeconds(r.staticDuration);
  const freeSec = staticSec === null || staticSec <= 0 ? durationSec : staticSec;

  const dist = r.distanceMeters;
  const distanceM = Number.isInteger(dist) && dist >= 0 && dist <= 10_000_000 ? dist : 0;

  // eslint-disable-next-line no-control-regex
  const description = typeof r.description === "string"
    ? r.description.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 80)
    : "";

  // Encoded polylines only use ASCII 63..126.
  const enc = r.polyline && r.polyline.encodedPolyline;
  const polyline = typeof enc === "string" && enc.length <= 100_000 && /^[\x3f-\x7e]*$/.test(enc) ? enc : "";

  const speeds = [];
  const raw = r.travelAdvisory && r.travelAdvisory.speedReadingIntervals;
  if (Array.isArray(raw)) {
    for (const iv of raw.slice(0, 5000)) {
      if (!iv || typeof iv !== "object") continue;
      const s = cleanIndex(iv.startPolylinePointIndex, 0);
      const e = cleanIndex(iv.endPolylinePointIndex, null);
      if (s === null || e === null || e <= s) continue;
      speeds.push([s, e, SPEED[iv.speed] ?? 0]);
    }
  }
  return { durationSec, freeSec, distanceM, description, polyline, speeds };
}

export function createGoogleClient({ apiKey, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!apiKey) throw new Error("Google API key is required");

  // opts: { origin, destination, depart: Date|null, full: boolean }
  async function computeRoutes({ origin, destination, depart, full }) {
    const body = {
      origin: waypoint(origin),
      destination: waypoint(destination),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      units: "METRIC",
    };
    if (depart) body.departureTime = depart.toISOString();
    if (full) {
      body.computeAlternativeRoutes = true;
      body.extraComputations = ["TRAFFIC_ON_POLYLINE"];
    }

    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": full ? FULL_MASK : LIGHT_MASK,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new GoogleError("upstream_error", 0, e && e.name === "TimeoutError" ? "timeout" : "network");
    }

    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new GoogleError("upstream_error", res.status, "response too large");

    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }

    if (!res.ok) {
      const gStatus = json && json.error && typeof json.error.status === "string" &&
        /^[A-Z_]{3,40}$/.test(json.error.status) ? json.error.status : "";
      if (res.status === 404 || (res.status === 400 && gStatus === "INVALID_ARGUMENT")) {
        throw new GoogleError("no_route", res.status, gStatus);
      }
      if (res.status === 401 || res.status === 403) throw new GoogleError("upstream_auth", res.status, gStatus);
      if (res.status === 429) throw new GoogleError("upstream_busy", res.status, gStatus);
      throw new GoogleError("upstream_error", res.status, gStatus);
    }

    const routes = json && Array.isArray(json.routes) ? json.routes.slice(0, 4) : [];
    const clean = routes.map(sanitizeRoute).filter(Boolean);
    if (!clean.length) throw new GoogleError("no_route", 200, "empty");
    return clean;
  }

  return { computeRoutes };
}
