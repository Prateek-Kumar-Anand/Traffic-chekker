import http from "node:http";
import { createServer } from "../src/app.js";
import { createMemoryStore } from "../src/store-memory.js";
import crypto from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createFirebaseVerifier } from "../src/auth.js";

export const PROJECT_ID = "traffic-test-project";
export const KID = "test-kid-1";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
export const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" });
const OTHER = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Builds a Firebase-style ID token. `claims` overrides the defaults; `header` overrides the JOSE header.
export function makeToken(claims = {}, { header = {}, signWith = privateKey, now = Date.parse("2026-11-04T10:00:00Z") } = {}) {
  const sec = Math.floor(now / 1000);
  const h = { alg: "RS256", kid: KID, typ: "JWT", ...header };
  const p = {
    iss: "https://securetoken.google.com/" + PROJECT_ID,
    aud: PROJECT_ID,
    sub: "user-abc123",
    iat: sec - 60,
    auth_time: sec - 60,
    exp: sec + 3600,
    email: "alice@example.com",
    email_verified: true,
    firebase: { sign_in_provider: "google.com" },
    ...claims,
  };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  const data = b64(h) + "." + b64(p);
  const sig = h.alg === "RS256" ? crypto.sign("RSA-SHA256", Buffer.from(data), signWith).toString("base64url") : "c2ln";
  return data + "." + sig;
}
export const wrongKeyToken = (claims) => makeToken(claims, { signWith: OTHER.privateKey });
export const GOOD_TOKEN = () => makeToken();

export const SECRET_KEY = "AIzaSy-TEST-SECRET-KEY-0123456789";
export const ORIGIN = "https://alice.github.io";

export function makeConfig(over = {}) {
  return Object.freeze({
    ...loadConfig({
      GOOGLE_MAPS_API_KEY: SECRET_KEY,
      MONGODB_URI: "mongodb://unused",
      IP_HASH_SECRET: "x".repeat(40),
      ALLOWED_ORIGINS: ORIGIN,
      FIREBASE_PROJECT_ID: PROJECT_ID,
    }),
    ...over,
  });
}

export function fakeGoogle({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async computeRoutes(args) {
      calls.push(args);
      if (fail) {
        const e = fail(args, calls.length);
        if (e) throw e;
      }
      return [{
        durationSec: args.full ? 1800 : 1500,
        freeSec: 1200,
        distanceM: 15000,
        description: "via NH27",
        polyline: args.full ? "_p~iF~ps|U_ulLnnqC_mqNvxq`@" : "",
        speeds: args.full ? [[0, 1, 0], [1, 2, 2]] : [],
      }];
    },
  };
}

export async function start(over = {}, googleOpts = {}) {
  const clock = { t: Date.parse("2026-11-04T10:00:00Z") };
  const now = () => clock.t;
  const store = over.store || createMemoryStore({ now });
  const google = over.google || fakeGoogle(googleOpts);
  const logs = [];
  const config = makeConfig({ userRateLimitPerMin: 1000, userRateLimitPerHour: 10000, ...(over.config || {}) });
  const certFetches = { n: 0 };
  const auth = over.auth || createFirebaseVerifier({
    projectId: PROJECT_ID,
    now,
    fetchCerts: async () => { certFetches.n++; return { certs: { [KID]: PUBLIC_PEM }, maxAgeSec: 3600 }; },
  });
  const server = createServer({ config, store, google, auth, now, log: (e) => logs.push(e) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    server, store, google, clock, logs, config, port, certFetches,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    call: (opts) => call(port, opts),
  };
}

export function call(port, { method = "POST", path = "/api/route", headers = {}, body, raw, origin = ORIGIN, chunked = false, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    // Signed in by default; pass token: null to send no Authorization header, or a string to send that token.
    if (token !== null && !h.Authorization) h.Authorization = "Bearer " + (token === undefined ? GOOD_TOKEN() : token);
    let payload = raw;
    if (payload === undefined && body !== undefined) {
      payload = JSON.stringify(body);
      if (!h["Content-Type"]) h["Content-Type"] = "application/json";
    }
    if (payload !== undefined && !chunked) h["Content-Length"] = Buffer.byteLength(payload);
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export const GOOD = { from: "Charbagh Railway Station, Lucknow", to: "Amausi Airport, Lucknow" };
