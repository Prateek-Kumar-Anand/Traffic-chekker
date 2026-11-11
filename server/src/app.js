import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { MAX_BODY_BYTES, validateBody, normalizePlace } from "./validate.js";
import { GoogleError } from "./google.js";
import { AuthError } from "./auth.js";

export const FORECAST_OFFSETS_MIN = [15, 30, 60, 90, 120, 180];

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  Vary: "Origin",
};

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// First four 16-bit groups of an IPv6 address (its /64), so one machine can't dodge
// the limiter by hopping between addresses inside its own block.
function v6prefix(ip) {
  const addr = ip.split("%")[0];
  const [head, tail = ""] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = addr.includes("::")
    ? [...h, ...Array(Math.max(8 - h.length - t.length, 0)).fill("0"), ...t]
    : h;
  return groups.slice(0, 4).map((g) => g.padStart(4, "0").toLowerCase()).join(":");
}

export function clientKey(req, trustProxyHops) {
  let ip = req.socket.remoteAddress || "unknown";
  if (trustProxyHops > 0) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string") {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      const cand = parts[parts.length - trustProxyHops];
      if (cand && net.isIP(cand)) ip = cand;
    }
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  return net.isIPv6(ip.split("%")[0]) ? "v6:" + v6prefix(ip) : ip;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, "payload_too_large", "Request is too large."));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

function defaultLog(entry) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
}

// Marks failures of the database layer so they can be told apart from bugs.
class StoreError extends Error {}

export function createServer({ config, store: rawStore, google, auth, now = Date.now, log = defaultLog }) {
  // With no Google key configured there is nothing to redact (splitting on "" would mangle every message).
  const redact = (s) => (config.googleKey ? String(s).split(config.googleKey).join("[redacted]") : String(s));
  const logSafe = (level, msg, extra = {}) => log({ level, msg: redact(msg), ...extra });

  // Every database call goes through this wrapper so any failure becomes a StoreError
  // (reported as 503, and Google is never called). Other exceptions stay ordinary 500s.
  const store = Object.fromEntries(["getCache", "setCache", "hit", "takeQuota", "ping", "touchUser", "getUser", "listUsers", "userCounts", "setBlocked", "getQuotaUsed"].map((k) => [
    k,
    async (...args) => {
      try { return await rawStore[k](...args); }
      catch (e) { throw new StoreError(`store.${k} failed: ${e && e.message ? e.message : e}`); }
    },
  ]));

  function send(res, status, body, extra = {}) {
    if (res.headersSent) return;
    const payload = body === null ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...BASE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      ...extra,
    });
    res.end(payload);
  }

  async function cachedOrFetch(key, fetcher) {
    const hit = await store.getCache(key);
    if (hit) return { value: hit, cached: true };
    const value = await fetcher();
    try { await store.setCache(key, value, config.cacheTtlSeconds); }
    catch (e) { logSafe("warn", "cache write failed: " + (e && e.message)); }
    return { value, cached: false };
  }

  const UID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
  const MAX_ADMIN_USERS = 200;
  const API_NOT_CONNECTED = () => new HttpError(503, "api_not_connected", "API not connected at the backend.");
  const isAdminEmail = (email) => config.adminEmails.includes(String(email).toLowerCase());

  // Everything a signed-in call needs, in the order that keeps abuse cheap:
  //   1. Verify the Firebase login (local crypto only; anonymous callers cost nothing else).
  //   2. Rate limit per network address and per account.
  //   3. Record who is calling and refuse blocked accounts (admins can never be locked out).
  // scope "route" is the expensive traffic check; anything else uses the looser "misc" limits.
  async function session(req, scope) {
    const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(String(req.headers.authorization || ""));
    if (!bearer) throw new HttpError(401, "unauthorized", "Sign in to use this service.", { "WWW-Authenticate": "Bearer" });
    const user = await auth.verify(bearer[1]); // AuthError is mapped in mapError()
    const isAdmin = isAdminEmail(user.email);

    const route = scope === "route";
    const perMin = route ? config.rateLimitPerMin : config.miscRateLimitPerMin;
    const perHour = route ? config.rateLimitPerHour : config.miscRateLimitPerHour;
    const uPerMin = route ? config.userRateLimitPerMin : config.miscRateLimitPerMin;
    const uPerHour = route ? config.userRateLimitPerHour : config.miscRateLimitPerHour;
    const hmac = (v) => crypto.createHmac("sha256", config.ipHashSecret).update(v).digest("hex").slice(0, 32);
    const ipId = hmac((route ? "" : "misc:") + clientKey(req, config.trustProxyHops));
    const userId = hmac((route ? "uid:" : "miscuid:") + user.uid); // 32 hex like ipId; the inputs differ, so ids never collide
    const hits = await Promise.all([
      store.hit(ipId, 60, perMin),
      store.hit(ipId, 3600, perHour),
      store.hit(userId, 60, uPerMin),
      store.hit(userId, 3600, uPerHour),
    ]);
    if (hits.some((h) => !h.allowed)) {
      const wait = Math.max(...hits.map((h) => (h.allowed ? 0 : h.retryAfterSec)));
      throw new HttpError(429, "rate_limited", "Too many requests. Please wait a moment and try again.", { "Retry-After": String(wait) });
    }

    const record = await store.touchUser(user, { countRequest: route });
    if (record.blocked && !isAdmin) {
      throw new HttpError(403, "account_blocked", "Your account has been blocked. Contact the site administrator.");
    }
    return { user, record, isAdmin };
  }

  function requireAdmin(sess) {
    if (!sess.isAdmin) throw new HttpError(403, "forbidden", "Only administrators can do this.");
  }

  async function readJson(req) {
    const mediaType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (mediaType !== "application/json") throw new HttpError(415, "unsupported_media_type", "Send JSON.");
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", "Request is too large.");
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    try { return JSON.parse(raw); }
    catch { throw new HttpError(400, "invalid_json", "Request is not valid JSON."); }
  }

  // Endpoints that take no input still read (and bound) the body so the connection stays healthy.
  const discardBody = (req) => readBody(req, MAX_BODY_BYTES);

  // Who am I? The website calls this right after sign-in to learn the role and whether the Maps API is connected.
  async function handleMe(req, res, cors) {
    const sess = await session(req, "misc");
    await discardBody(req);
    send(res, 200, {
      role: sess.isAdmin ? "admin" : "user",
      email: sess.user.email,
      mapsConnected: Boolean(google),
    }, cors);
  }

  async function handleOverview(req, res, cors) {
    const sess = await session(req, "misc");
    requireAdmin(sess);
    await discardBody(req);
    const day = new Date(now()).toISOString().slice(0, 10);
    const [used, users] = await Promise.all([store.getQuotaUsed(day), store.userCounts()]);
    send(res, 200, {
      api: { maps: Boolean(google), database: true }, // if the database were down, the calls above would have failed with 503
      usage: { day, googleCallsToday: used, dailyLimit: config.dailyGoogleCallLimit },
      users,
      admins: config.adminEmails.length,
    }, cors);
  }

  async function handleUsers(req, res, cors) {
    const sess = await session(req, "misc");
    requireAdmin(sess);
    await discardBody(req);
    const list = await store.listUsers(MAX_ADMIN_USERS + 1);
    send(res, 200, {
      users: list.slice(0, MAX_ADMIN_USERS).map((u) => ({ ...u, isAdmin: isAdminEmail(u.email) })),
      truncated: list.length > MAX_ADMIN_USERS,
    }, cors);
  }

  async function handleBlock(req, res, cors) {
    const sess = await session(req, "misc");
    requireAdmin(sess);
    const body = await readJson(req);
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (keys.length !== 2 || !keys.includes("uid") || !keys.includes("blocked") ||
        typeof body.uid !== "string" || !UID_RE.test(body.uid) || typeof body.blocked !== "boolean") {
      throw new HttpError(400, "invalid_request", "Send { uid, blocked }.");
    }
    const target = await store.getUser(body.uid);
    if (!target) throw new HttpError(404, "not_found", "That person has not signed in yet.");
    if (isAdminEmail(target.email) || target.uid === sess.user.uid) {
      throw new HttpError(400, "cannot_block_admin", "Administrators cannot be blocked.");
    }
    const updated = await store.setBlocked(body.uid, body.blocked);
    logSafe("info", body.blocked ? "admin blocked a user" : "admin unblocked a user", { actor: sess.user.uid, target: body.uid });
    send(res, 200, { uid: body.uid, blocked: Boolean(updated && updated.blocked) }, cors);
  }

  async function handleRoute(req, res, cors) {
    const sess = await session(req, "route");
    if (!google) throw API_NOT_CONNECTED(); // no Maps key at the backend: say so plainly, spend nothing

    // 3. Content type and body.
    const parsed = await readJson(req);

    // 4. Strict validation.
    const v = validateBody(parsed, now());
    if (!v.ok) throw new HttpError(400, "invalid_request", v.error);
    const { origin, destination, depart, forecast: wantForecast } = v.value;

    // 5. Cache, then spend quota only for what we really have to fetch.
    const bucket = depart ? Math.floor(depart.getTime() / 300_000) : "now";
    const base = `v1|${normalizePlace(origin)}|${normalizePlace(destination)}|${bucket}`;
    const day = new Date(now()).toISOString().slice(0, 10);

    const quotaDenied = () => {
      const msToMidnight = Date.parse(day + "T00:00:00Z") + 86_400_000 - now();
      return new HttpError(503, "quota_exceeded", "The daily traffic-lookup limit has been reached. Please try again tomorrow.",
        { "Retry-After": String(Math.max(60, Math.ceil(msToMidnight / 1000))) });
    };

    const main = await cachedOrFetch(sha256("main|" + base), async () => {
      if (!(await store.takeQuota(day, 1, config.dailyGoogleCallLimit))) throw quotaDenied();
      const routes = await google.computeRoutes({ origin, destination, depart, full: true });
      return { generatedAt: new Date(now()).toISOString(), routes };
    });

    let forecast = null;
    if (wantForecast) {
      const fcKey = sha256("fc|" + base);
      let fc = await store.getCache(fcKey);
      if (!fc) {
        const cost = FORECAST_OFFSETS_MIN.length;
        if (await store.takeQuota(day, cost, config.dailyGoogleCallLimit)) {
          const baseMs = depart ? depart.getTime() : now();
          const settled = await Promise.allSettled(FORECAST_OFFSETS_MIN.map((off) =>
            google.computeRoutes({ origin, destination, depart: new Date(baseMs + off * 60_000), full: false })));
          const points = [];
          settled.forEach((s, i) => {
            if (s.status === "fulfilled") {
              const r = s.value[0];
              points.push({ offsetMin: FORECAST_OFFSETS_MIN[i], durationSec: r.durationSec, freeSec: r.freeSec });
            } else {
              logSafe("warn", "forecast point failed: " + (s.reason && s.reason.message));
            }
          });
          fc = { points };
          try { await store.setCache(fcKey, fc, config.cacheTtlSeconds); }
          catch (e) { logSafe("warn", "cache write failed: " + (e && e.message)); }
        }
      }
      forecast = fc ? fc.points : null;
    }

    send(res, 200, { routes: main.value.routes, forecast, cached: main.cached, generatedAt: main.value.generatedAt }, cors);
  }

  function mapError(err) {
    if (err instanceof HttpError) return err;
    if (err instanceof AuthError) {
      if (err.kind === "unverified") return new HttpError(403, "email_not_verified", "Confirm your email address, then try again.");
      if (err.kind === "unavailable") {
        logSafe("error", err.message);
        return new HttpError(503, "service_unavailable", "The service is temporarily unavailable.");
      }
      return new HttpError(401, "unauthorized", "Your session is not valid. Please sign in again.", { "WWW-Authenticate": "Bearer" });
    }
    if (err instanceof StoreError) {
      logSafe("error", err.message);
      return new HttpError(503, "service_unavailable", "The service is temporarily unavailable.");
    }
    if (err instanceof GoogleError) {
      if (err.kind === "no_route") {
        return new HttpError(404, "no_route", "Could not find a driving route between those places. Try adding the city name.");
      }
      if (err.kind === "upstream_auth") {
        // A rejected key or switched-off billing means the Maps API is not usable: tell the website so.
        logSafe("error", "GOOGLE KEY OR BILLING PROBLEM: " + err.message);
        return API_NOT_CONNECTED();
      } else {
        logSafe("warn", err.message);
      }
      const retry = err.kind === "upstream_busy" ? { "Retry-After": "30" } : {};
      return new HttpError(err.kind === "upstream_busy" ? 503 : 502, "upstream_error",
        "The traffic service is temporarily unavailable. Please try again shortly.", retry);
    }
    logSafe("error", "unhandled: " + (err && err.stack ? err.stack : err));
    return new HttpError(500, "internal_error", "Something went wrong.");
  }

  const ENDPOINTS = {
    "/api/route": handleRoute,
    "/api/me": handleMe,
    "/api/admin/overview": handleOverview,
    "/api/admin/users": handleUsers,
    "/api/admin/block": handleBlock,
  };

  async function handle(req, res) {
    let path;
    try { path = new URL(req.url, "http://localhost").pathname; }
    catch { return send(res, 400, { error: "bad_request" }); }

    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
      try { await store.ping(); return send(res, 200, { ok: true }); }
      catch { return send(res, 503, { ok: false }); }
    }

    const handler = ENDPOINTS[path];
    if (!handler) return send(res, 404, { error: "not_found" });

    // CORS allowlist: exact origin match, no wildcard, no credentials.
    // NOTE: CORS only controls which *browser pages* may read responses. It is not
    // authentication. Callers must also present a valid Firebase login token (see handleRoute),
    // and the rate limits and daily quota still cap what a signed-in account can spend.
    const origin = req.headers.origin;
    let cors = {};
    if (origin !== undefined) {
      if (!config.allowedOrigins.includes(origin)) {
        return send(res, 403, { error: "forbidden_origin", message: "This site is not allowed to use the API." });
      }
      // Browsers hide Retry-After from cross-origin pages unless it is exposed explicitly.
      cors = { "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "Retry-After" };
    } else if (config.requireOrigin) {
      return send(res, 403, { error: "forbidden_origin", message: "This site is not allowed to use the API." });
    }

    if (req.method === "OPTIONS") {
      return send(res, 204, null, {
        ...cors,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "600",
      });
    }
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { ...cors, Allow: "POST, OPTIONS" });

    try {
      await handler(req, res, cors);
    } catch (err) {
      const out = mapError(err);
      if (out.status === 413) res.once("finish", () => req.destroy());
      send(res, out.status, { error: out.code, message: out.message },
        { ...cors, ...out.headers, ...(out.status === 413 ? { Connection: "close" } : {}) });
    }
  }

  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const started = Date.now();
    res.on("finish", () => log({ level: "info", t: new Date().toISOString(), method: req.method, path: (req.url || "").split("?")[0].slice(0, 100), status: res.statusCode, ms: Date.now() - started }));
    handle(req, res).catch((e) => {
      logSafe("error", "fatal handler error: " + (e && e.stack ? e.stack : e));
      send(res, 500, { error: "internal_error", message: "Something went wrong." });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
