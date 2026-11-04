// Strict input validation. Anything that is not exactly what we expect is rejected.
// Validated values are only ever used as strings/numbers in the outgoing Google request
// and are hashed before they touch MongoDB, so no user value is ever a query operator.

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const COORDS = /^(-?\d{1,2}(?:\.\d{1,10})?)\s*,\s*(-?\d{1,3}(?:\.\d{1,10})?)$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const MAX_BODY_BYTES = 2048;
export const MAX_DEPART_AHEAD_MS = 7 * 24 * 3600 * 1000;
const ALLOWED_KEYS = new Set(["from", "to", "depart", "forecast"]);

export function validatePlace(value, label) {
  if (typeof value !== "string") return { ok: false, error: `${label} must be text` };
  // Reject control characters (including newlines) outright instead of rewriting them.
  // Tabs from pasted text are the one exception: they become plain spaces.
  const spaced = value.replace(/\t/g, " ");
  if (CONTROL_CHARS.test(spaced)) return { ok: false, error: `${label} contains invalid characters` };
  const text = spaced.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 200) {
    return { ok: false, error: `${label} must be between 2 and 200 characters` };
  }

  const m = COORDS.exec(text);
  if (m) {
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) {
      return { ok: false, error: `${label} coordinates are out of range` };
    }
    return { ok: true, value: { kind: "coords", lat, lng } };
  }
  return { ok: true, value: { kind: "address", text } };
}

// Returns { ok:true, value:{ origin, destination, depart:Date|null, forecast:boolean } }
export function validateBody(body, nowMs) {
  if (body === null || typeof body !== "object" || Array.isArray(body) ||
      Object.getPrototypeOf(body) !== Object.prototype) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  for (const k of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(k)) return { ok: false, error: "Unexpected field in request" };
  }

  const origin = validatePlace(body.from, "From");
  if (!origin.ok) return origin;
  const destination = validatePlace(body.to, "To");
  if (!destination.ok) return destination;

  let forecast = false;
  if (body.forecast !== undefined) {
    if (typeof body.forecast !== "boolean") return { ok: false, error: "forecast must be true or false" };
    forecast = body.forecast;
  }

  let depart = null;
  if (body.depart !== undefined && body.depart !== null) {
    if (typeof body.depart !== "string" || !ISO_WITH_ZONE.test(body.depart)) {
      return { ok: false, error: "depart must be an ISO 8601 date-time with a time zone" };
    }
    const t = Date.parse(body.depart);
    if (Number.isNaN(t)) return { ok: false, error: "depart is not a valid date-time" };
    if (t > nowMs + MAX_DEPART_AHEAD_MS) {
      return { ok: false, error: "depart can be at most 7 days ahead" };
    }
    // Times in the past (or within the next minute) mean "leave now".
    depart = t < nowMs + 60_000 ? null : new Date(t);
  }

  return { ok: true, value: { origin: origin.value, destination: destination.value, depart, forecast } };
}

// Stable text form of a place for cache keys.
export function normalizePlace(p) {
  return p.kind === "coords"
    ? `c:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
    : `a:${p.text.toLowerCase()}`;
}
