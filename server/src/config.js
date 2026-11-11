// Loads and validates configuration from environment variables.
// Every secret comes from the environment; nothing is hard-coded or logged.

function parseOrigin(raw, errors) {
  if (raw === "*") {
    errors.push('ALLOWED_ORIGINS must list exact origins, "*" is not allowed');
    return null;
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    errors.push(`ALLOWED_ORIGINS has an invalid origin: ${raw.slice(0, 80)}`);
    return null;
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) {
    errors.push(`ALLOWED_ORIGINS must use https (http only for localhost): ${raw.slice(0, 80)}`);
    return null;
  }
  if (u.origin !== raw) {
    errors.push(`ALLOWED_ORIGINS entries must be a bare origin with no path or trailing slash: ${raw.slice(0, 80)}`);
    return null;
  }
  return u.origin;
}

function intVar(env, name, def, min, max, errors) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  if (!/^\d{1,9}$/.test(raw.trim())) {
    errors.push(`${name} must be a whole number`);
    return def;
  }
  const n = Number(raw.trim());
  if (n < min || n > max) {
    errors.push(`${name} must be between ${min} and ${max}`);
    return def;
  }
  return n;
}

export function loadConfig(env = process.env) {
  const errors = [];

  const need = (name) => {
    const v = (env[name] || "").trim();
    if (!v) errors.push(`${name} is required`);
    return v;
  };

  // Optional on purpose: without it the backend still starts and tells the website
  // "API not connected at the backend", instead of refusing to deploy.
  const googleKey = (env.GOOGLE_MAPS_API_KEY || "").trim();

  // People who may open the admin console. Matched against the *verified* email in their Firebase login.
  const adminEmails = (env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const e of adminEmails) {
    if (e.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e)) errors.push(`ADMIN_EMAILS has an invalid email: ${e.slice(0, 80)}`);
  }
  // Firebase project that issues the login tokens. Not a secret: it is the "projectId" in the web config.
  const firebaseProjectId = need("FIREBASE_PROJECT_ID");
  if (firebaseProjectId && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(firebaseProjectId)) {
    errors.push("FIREBASE_PROJECT_ID must be the Firebase project id (lowercase letters, digits and hyphens)");
  }
  const mongoUri = need("MONGODB_URI");
  const ipHashSecret = need("IP_HASH_SECRET");
  if (ipHashSecret && ipHashSecret.length < 32) {
    errors.push("IP_HASH_SECRET must be at least 32 characters (use a long random value)");
  }

  const rawOrigins = need("ALLOWED_ORIGINS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = rawOrigins.map((o) => parseOrigin(o, errors)).filter(Boolean);

  const requireOrigin = (env.REQUIRE_ORIGIN || "true").trim().toLowerCase() !== "false";

  const cfg = {
    googleKey,
    adminEmails: Object.freeze(adminEmails),
    firebaseProjectId,
    mongoUri,
    mongoDb: (env.MONGODB_DB || "trafficchecker").trim(),
    ipHashSecret,
    allowedOrigins,
    requireOrigin,
    port: intVar(env, "PORT", 8080, 1, 65535, errors),
    // Number of reverse proxies in front of this server (0 = none). Wrong values let
    // clients spoof their IP and dodge rate limits, so the default is the safe 0.
    trustProxyHops: intVar(env, "TRUST_PROXY_HOPS", 0, 0, 5, errors),
    rateLimitPerMin: intVar(env, "RATE_LIMIT_PER_MIN", 10, 1, 10000, errors),
    rateLimitPerHour: intVar(env, "RATE_LIMIT_PER_HOUR", 100, 1, 100000, errors),
    // The same limits, counted per signed-in account, so one account cannot dodge them by changing IP.
    userRateLimitPerMin: intVar(env, "USER_RATE_LIMIT_PER_MIN", 10, 1, 10000, errors),
    userRateLimitPerHour: intVar(env, "USER_RATE_LIMIT_PER_HOUR", 100, 1, 100000, errors),
    // Looser limits for the light endpoints (who am I, admin console), counted separately from traffic checks.
    miscRateLimitPerMin: intVar(env, "MISC_RATE_LIMIT_PER_MIN", 60, 1, 100000, errors),
    miscRateLimitPerHour: intVar(env, "MISC_RATE_LIMIT_PER_HOUR", 600, 1, 1000000, errors),
    dailyGoogleCallLimit: intVar(env, "DAILY_GOOGLE_CALL_LIMIT", 1000, 1, 10000000, errors),
    cacheTtlSeconds: intVar(env, "CACHE_TTL_SECONDS", 120, 10, 3600, errors),
  };

  if (errors.length) {
    throw new Error("Invalid configuration:\n - " + errors.join("\n - "));
  }
  return Object.freeze(cfg);
}
