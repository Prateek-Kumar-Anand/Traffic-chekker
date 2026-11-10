import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { validatePlace } from "../src/validate.js";
import { clientKey } from "../src/app.js";
import { createGoogleClient, sanitizeRoute, GoogleError } from "../src/google.js";
import { SECRET_KEY } from "./helpers.js";

const ENV = {
  GOOGLE_MAPS_API_KEY: "k",
  MONGODB_URI: "mongodb://x",
  IP_HASH_SECRET: "s".repeat(32),
  ALLOWED_ORIGINS: "https://a.github.io",
  FIREBASE_PROJECT_ID: "my-traffic-app",
};

test("config: requires secrets and rejects weak or unsafe values", () => {
  assert.throws(() => loadConfig({}), /GOOGLE_MAPS_API_KEY is required/);
  assert.throws(() => loadConfig({ ...ENV, IP_HASH_SECRET: "short" }), /at least 32/);
  assert.throws(() => loadConfig({ ...ENV, ALLOWED_ORIGINS: "*" }), /not allowed/);
  assert.throws(() => loadConfig({ ...ENV, ALLOWED_ORIGINS: "http://example.com" }), /https/);
  assert.throws(() => loadConfig({ ...ENV, ALLOWED_ORIGINS: "https://a.github.io/repo/" }), /bare origin/);
  assert.throws(() => loadConfig({ ...ENV, RATE_LIMIT_PER_MIN: "abc" }), /whole number/);
  assert.throws(() => loadConfig({ ...ENV, TRUST_PROXY_HOPS: "50" }), /between/);
  assert.throws(() => loadConfig({ ...ENV, FIREBASE_PROJECT_ID: "" }), /FIREBASE_PROJECT_ID is required/);
  assert.throws(() => loadConfig({ ...ENV, FIREBASE_PROJECT_ID: "Bad Id!" }), /Firebase project id/);
  const ok = loadConfig({ ...ENV, ALLOWED_ORIGINS: "https://a.github.io, http://localhost:8000" });
  assert.deepEqual(ok.allowedOrigins, ["https://a.github.io", "http://localhost:8000"]);
  assert.equal(ok.requireOrigin, true);
  assert.equal(ok.trustProxyHops, 0);
  assert.ok(Object.isFrozen(ok));
});

test("config: error messages never echo secret values", () => {
  try { loadConfig({ ...ENV, GOOGLE_MAPS_API_KEY: "SUPERSECRET", IP_HASH_SECRET: "tiny" }); }
  catch (e) { assert.ok(!e.message.includes("SUPERSECRET")); assert.ok(!e.message.includes("tiny")); return; }
  assert.fail("should have thrown");
});

test("validatePlace basics", () => {
  assert.equal(validatePlace("  Lucknow  Airport ", "From").value.text, "Lucknow Airport");
  assert.deepEqual(validatePlace("26.85,80.95", "From").value, { kind: "coords", lat: 26.85, lng: 80.95 });
  assert.equal(validatePlace("‮ evil", "From").ok, true); // bidi override is allowed text but is never rendered as HTML
  assert.equal(validatePlace("bad\u0007bell", "From").ok, false);
  assert.equal(validatePlace(null, "From").ok, false);
});

function fakeReq(remote, xff) {
  return { socket: { remoteAddress: remote }, headers: xff ? { "x-forwarded-for": xff } : {} };
}

test("clientKey: IPv6 clients share a /64, mapped IPv4 is unwrapped, XFF respects hop count", () => {
  assert.equal(clientKey(fakeReq("::ffff:203.0.113.9"), 0), "203.0.113.9");
  const a = clientKey(fakeReq("2001:db8:abcd:12::1"), 0);
  const b = clientKey(fakeReq("2001:db8:abcd:12:ffff:ffff:ffff:ffff"), 0);
  assert.equal(a, b);
  assert.notEqual(a, clientKey(fakeReq("2001:db8:abcd:13::1"), 0));
  assert.equal(clientKey(fakeReq("10.0.0.1", "1.2.3.4, 5.6.7.8"), 0), "10.0.0.1");
  assert.equal(clientKey(fakeReq("10.0.0.1", "1.2.3.4, 5.6.7.8"), 1), "5.6.7.8");
  assert.equal(clientKey(fakeReq("10.0.0.1", "1.2.3.4, 5.6.7.8"), 2), "1.2.3.4");
  assert.equal(clientKey(fakeReq("10.0.0.1", "not-an-ip"), 1), "10.0.0.1");
});

test("sanitizeRoute drops bad data and strips unsafe content from Google's response", () => {
  assert.equal(sanitizeRoute({ duration: "abc" }), null);
  assert.equal(sanitizeRoute(null), null);
  const r = sanitizeRoute({
    duration: "1800s", staticDuration: "1200s", distanceMeters: 15000,
    description: "via <b>NH27</b>\u0000" + "x".repeat(200),
    polyline: { encodedPolyline: "_p~iF~ps|U" },
    travelAdvisory: { speedReadingIntervals: [
      { endPolylinePointIndex: 5, speed: "TRAFFIC_JAM" },                       // start omitted = 0
      { startPolylinePointIndex: 5, endPolylinePointIndex: 9, speed: "SLOW" },
      { startPolylinePointIndex: 9, endPolylinePointIndex: 3, speed: "NORMAL" }, // reversed: dropped
      { startPolylinePointIndex: "x", endPolylinePointIndex: 3 },               // wrong type: dropped
      { startPolylinePointIndex: 9, endPolylinePointIndex: 12, speed: "WEIRD" }, // unknown speed -> normal
    ] },
  });
  assert.equal(r.durationSec, 1800);
  assert.equal(r.freeSec, 1200);
  assert.ok(r.description.length <= 80 && !r.description.includes("\u0000"));
  assert.equal(r.polyline, "_p~iF~ps|U");
  assert.deepEqual(r.speeds, [[0, 5, 2], [5, 9, 1], [9, 12, 0]]);

  const evil = sanitizeRoute({ duration: "10s", polyline: { encodedPolyline: "abc<script>" } });
  assert.equal(evil.polyline, "");
  assert.equal(sanitizeRoute({ duration: "100s", staticDuration: "0s" }).freeSec, 100);
});

function fetchReturning(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}
const PLACE = { kind: "address", text: "Delhi" };

test("google client sends key only in a header, with a field mask, over https", async () => {
  const f = fetchReturning(200, { routes: [{ duration: "100s", staticDuration: "90s" }] });
  const g = createGoogleClient({ apiKey: SECRET_KEY, fetchImpl: f });
  await g.computeRoutes({ origin: PLACE, destination: { kind: "coords", lat: 1.5, lng: 2.5 }, depart: new Date("2026-11-05T00:00:00Z"), full: true });
  const { url, init } = f.calls[0];
  assert.equal(url, "https://routes.googleapis.com/directions/v2:computeRoutes");
  assert.ok(!url.includes(SECRET_KEY));
  assert.equal(init.headers["X-Goog-Api-Key"], SECRET_KEY);
  assert.match(init.headers["X-Goog-FieldMask"], /routes\.polyline\.encodedPolyline/);
  assert.equal(init.redirect, "error");
  const body = JSON.parse(init.body);
  assert.equal(body.routingPreference, "TRAFFIC_AWARE");
  assert.equal(body.departureTime, "2026-11-05T00:00:00.000Z");
  assert.deepEqual(body.destination, { location: { latLng: { latitude: 1.5, longitude: 2.5 } } });
  assert.deepEqual(body.origin, { address: "Delhi" });
  assert.deepEqual(body.extraComputations, ["TRAFFIC_ON_POLYLINE"]);
});

test("google client light mode asks for durations only", async () => {
  const f = fetchReturning(200, { routes: [{ duration: "100s", staticDuration: "90s" }] });
  const g = createGoogleClient({ apiKey: "k", fetchImpl: f });
  await g.computeRoutes({ origin: PLACE, destination: PLACE, depart: null, full: false });
  assert.equal(f.calls[0].init.headers["X-Goog-FieldMask"], "routes.duration,routes.staticDuration");
  assert.equal(JSON.parse(f.calls[0].init.body).extraComputations, undefined);
  assert.equal(JSON.parse(f.calls[0].init.body).departureTime, undefined);
});

test("google client error mapping and key-free error messages", async () => {
  const run = async (status, body) => {
    const g = createGoogleClient({ apiKey: SECRET_KEY, fetchImpl: fetchReturning(status, body) });
    try { await g.computeRoutes({ origin: PLACE, destination: PLACE, depart: null, full: true }); }
    catch (e) { return e; }
    return null;
  };
  assert.equal((await run(404, { error: { status: "NOT_FOUND" } })).kind, "no_route");
  assert.equal((await run(400, { error: { status: "INVALID_ARGUMENT", message: "x" } })).kind, "no_route");
  assert.equal((await run(200, { routes: [] })).kind, "no_route");
  assert.equal((await run(200, {})).kind, "no_route");
  assert.equal((await run(403, { error: { status: "PERMISSION_DENIED", message: `key ${SECRET_KEY} bad` } })).kind, "upstream_auth");
  assert.equal((await run(429, {})).kind, "upstream_busy");
  assert.equal((await run(500, "<html>oops</html>")).kind, "upstream_error");
  const e = await run(403, { error: { status: "PERMISSION_DENIED", message: `key ${SECRET_KEY} bad` } });
  assert.ok(e instanceof GoogleError);
  assert.ok(!e.message.includes(SECRET_KEY), "Google's message text must not be copied into errors");
});

test("google client turns network failures and timeouts into upstream_error", async () => {
  const boom = async () => { throw Object.assign(new Error("connect ECONNRESET with " + SECRET_KEY), { name: "Error" }); };
  const g = createGoogleClient({ apiKey: SECRET_KEY, fetchImpl: boom });
  await assert.rejects(() => g.computeRoutes({ origin: PLACE, destination: PLACE, depart: null, full: true }),
    (e) => e.kind === "upstream_error" && !e.message.includes(SECRET_KEY));
});

const SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]");

test("source files contain no literal line/paragraph separators (they silently break regex literals)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  for (const dir of ["../src", "."]) {
    const base = new URL(dir + "/", import.meta.url);
    for (const f of readdirSync(base).filter((n) => n.endsWith(".js"))) {
      const text = readFileSync(new URL(f, base), "utf8");
      assert.ok(!SEPARATORS.test(text), `${f} contains a literal U+2028/U+2029`);
    }
  }
});
