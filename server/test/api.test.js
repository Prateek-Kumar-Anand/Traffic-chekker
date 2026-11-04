import test from "node:test";
import assert from "node:assert/strict";
import { start, GOOD, ORIGIN, SECRET_KEY, fakeGoogle } from "./helpers.js";
import { GoogleError } from "../src/google.js";

async function withServer(over, googleOpts, fn) {
  const s = await start(over, googleOpts);
  try { await fn(s); } finally { await s.close(); }
}

test("happy path returns sanitised routes and never the API key", async () => {
  await withServer({}, {}, async (s) => {
    const r = await s.call({ body: GOOD });
    assert.equal(r.status, 200);
    assert.equal(r.json.routes[0].durationSec, 1800);
    assert.equal(r.json.routes[0].freeSec, 1200);
    assert.equal(r.json.forecast, null);
    assert.equal(r.json.cached, false);
    assert.ok(!r.text.includes(SECRET_KEY));
    assert.equal(r.headers["access-control-allow-origin"], ORIGIN);
  });
});

test("security headers are set and x-powered-by is absent", async () => {
  await withServer({}, {}, async (s) => {
    const r = await s.call({ body: GOOD });
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.match(r.headers["content-security-policy"], /default-src 'none'/);
    assert.match(r.headers["strict-transport-security"], /max-age=31536000/);
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["x-powered-by"], undefined);
  });
});

test("NoSQL-injection style payloads are rejected before any query", async () => {
  await withServer({}, {}, async (s) => {
    const bad = [
      { from: { $ne: null }, to: "Delhi" },
      { from: "Delhi", to: { $gt: "" } },
      { from: ["Delhi"], to: "Agra" },
      { from: "Delhi", to: "Agra", $where: "sleep(1000)" },
      { from: "Delhi", to: "Agra", __proto__: { admin: true }, extra: 1 },
      { from: 12345, to: "Agra" },
      { from: "Delhi", to: "Agra", forecast: "yes" },
    ];
    for (const body of bad) {
      const r = await s.call({ body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(s.google.calls.length, 0);
  });
});

test("arrays, null and non-objects as the whole body are rejected", async () => {
  await withServer({}, {}, async (s) => {
    for (const raw of ["[]", "null", "42", '"hello"', "true"]) {
      const r = await s.call({ raw, headers: { "Content-Type": "application/json" } });
      assert.equal(r.status, 400, raw);
    }
  });
});

test("bad place text is rejected: too short/long, control characters, bad coordinates", async () => {
  await withServer({}, {}, async (s) => {
    const cases = [
      { from: "a", to: "Delhi" },
      { from: "x".repeat(201), to: "Delhi" },
      { from: "Delhi\u0000", to: "Agra" },
      { from: "Delhi\nHost: evil", to: "Agra" },
      { from: "95.0, 10.0", to: "Agra" },
      { from: "10.0, 200.0", to: "Agra" },
    ];
    for (const body of cases) assert.equal((await s.call({ body })).status, 400, JSON.stringify(body).slice(0, 60));
  });
});

test("coordinates and markup-looking text are accepted as plain data", async () => {
  await withServer({}, {}, async (s) => {
    const r = await s.call({ body: { from: "26.8467, 80.9462", to: "<script>alert(1)</script> Lucknow" } });
    assert.equal(r.status, 200);
    assert.equal(s.google.calls[0].origin.kind, "coords");
    assert.equal(s.google.calls[0].destination.kind, "address");
  });
});

test("malformed JSON, wrong content type, oversized bodies", async () => {
  await withServer({}, {}, async (s) => {
    assert.equal((await s.call({ raw: "{not json", headers: { "Content-Type": "application/json" } })).status, 400);
    assert.equal((await s.call({ raw: JSON.stringify(GOOD), headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await s.call({ raw: JSON.stringify(GOOD) })).status, 415);
    const big = JSON.stringify({ ...GOOD, pad: "y".repeat(5000) });
    const r = await s.call({ raw: big, headers: { "Content-Type": "application/json" } });
    assert.equal(r.status, 413);
  });
});

test("oversized chunked body without Content-Length is cut off", async () => {
  await withServer({}, {}, async (s) => {
    const big = JSON.stringify({ ...GOOD, pad: "y".repeat(5000) });
    const r = await s.call({ raw: big, chunked: true, headers: { "Content-Type": "application/json" } });
    assert.equal(r.status, 413);
  });
});

test("departure time rules", async () => {
  await withServer({}, {}, async (s) => {
    const now = s.clock.t;
    const iso = (ms) => new Date(now + ms).toISOString();
    assert.equal((await s.call({ body: { ...GOOD, depart: "tomorrow" } })).status, 400);
    assert.equal((await s.call({ body: { ...GOOD, depart: "2026-11-04T10:30" } })).status, 400); // no zone
    assert.equal((await s.call({ body: { ...GOOD, depart: iso(8 * 86400000) } })).status, 400);
    assert.equal((await s.call({ body: { ...GOOD, depart: 12345 } })).status, 400);
    // past time means "now": no departureTime is sent to Google
    assert.equal((await s.call({ body: { ...GOOD, depart: iso(-3600_000) } })).status, 200);
    assert.equal(s.google.calls[0].depart, null);
    // a real future time is passed through
    assert.equal((await s.call({ body: { ...GOOD, from: "Kanpur", depart: iso(3600_000) } })).status, 200);
    assert.equal(s.google.calls[1].depart.getTime(), now + 3600_000);
  });
});

test("CORS: disallowed origin blocked, missing origin blocked, preflight answered", async () => {
  await withServer({}, {}, async (s) => {
    const evil = await s.call({ body: GOOD, origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers["access-control-allow-origin"], undefined);

    const lookalike = await s.call({ body: GOOD, origin: "https://alice.github.io.evil.example" });
    assert.equal(lookalike.status, 403);

    const none = await s.call({ body: GOOD, origin: null });
    assert.equal(none.status, 403);

    const pre = await s.call({ method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(pre.headers["access-control-allow-methods"], "POST, OPTIONS");
    assert.equal(pre.headers["access-control-allow-credentials"], undefined);

    const preEvil = await s.call({ method: "OPTIONS", origin: "https://evil.example" });
    assert.equal(preEvil.status, 403);
    assert.equal(s.google.calls.length, 0);
  });
});

test("REQUIRE_ORIGIN=false lets non-browser clients in (but wrong origins still fail)", async () => {
  await withServer({ config: { requireOrigin: false } }, {}, async (s) => {
    assert.equal((await s.call({ body: GOOD, origin: null })).status, 200);
    assert.equal((await s.call({ body: GOOD, origin: "https://evil.example" })).status, 403);
  });
});

test("wrong methods and unknown paths", async () => {
  await withServer({}, {}, async (s) => {
    const g = await s.call({ method: "GET" });
    assert.equal(g.status, 405);
    assert.equal(g.headers.allow, "POST, OPTIONS");
    assert.equal((await s.call({ method: "DELETE" })).status, 405);
    assert.equal((await s.call({ method: "GET", path: "/admin", origin: null })).status, 404);
    assert.equal((await s.call({ method: "GET", path: "/.env", origin: null })).status, 404);
    assert.equal((await s.call({ method: "GET", path: "/api/route/../../etc/passwd", origin: null })).status, 404);
    const h = await s.call({ method: "GET", path: "/healthz", origin: null });
    assert.equal(h.status, 200);
  });
});

test("rate limit: per-minute limit returns 429 with Retry-After, and Google is not called", async () => {
  await withServer({ config: { rateLimitPerMin: 3 } }, {}, async (s) => {
    for (let i = 0; i < 3; i++) assert.equal((await s.call({ body: { ...GOOD, from: "Place " + i } })).status, 200);
    const r = await s.call({ body: { ...GOOD, from: "Place 99" } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers["retry-after"]) >= 1);
    // without this, browsers on another origin cannot read Retry-After at all
    assert.equal(r.headers["access-control-expose-headers"], "Retry-After");
    assert.equal(r.json.error, "rate_limited");
    assert.equal(s.google.calls.length, 3);
    // bad requests count against the limit too
    s.clock.t += 61_000;
    for (let i = 0; i < 3; i++) await s.call({ raw: "{", headers: { "Content-Type": "application/json" } });
    assert.equal((await s.call({ body: GOOD })).status, 429);
  });
});

test("rate limit: hourly limit applies across minutes", async () => {
  await withServer({ config: { rateLimitPerMin: 100, rateLimitPerHour: 4 } }, {}, async (s) => {
    for (let i = 0; i < 4; i++) {
      assert.equal((await s.call({ body: { ...GOOD, from: "P" + i } })).status, 200);
      s.clock.t += 61_000;
    }
    assert.equal((await s.call({ body: GOOD })).status, 429);
  });
});

test("X-Forwarded-For is ignored unless proxy hops are configured (no limiter bypass)", async () => {
  await withServer({ config: { rateLimitPerMin: 2 } }, {}, async (s) => {
    for (let i = 0; i < 2; i++) {
      await s.call({ body: { ...GOOD, from: "P" + i }, headers: { "X-Forwarded-For": "1.1.1." + i } });
    }
    const r = await s.call({ body: GOOD, headers: { "X-Forwarded-For": "9.9.9.9" } });
    assert.equal(r.status, 429);
  });
  await withServer({ config: { rateLimitPerMin: 1, trustProxyHops: 1 } }, {}, async (s) => {
    // The last entry is the one our own proxy appended; earlier entries are client-controlled.
    assert.equal((await s.call({ body: GOOD, headers: { "X-Forwarded-For": "6.6.6.6, 10.0.0.1" } })).status, 200);
    assert.equal((await s.call({ body: { ...GOOD, from: "Other" }, headers: { "X-Forwarded-For": "7.7.7.7, 10.0.0.1" } })).status, 429);
    assert.equal((await s.call({ body: { ...GOOD, from: "Third" }, headers: { "X-Forwarded-For": "7.7.7.7, 10.0.0.2" } })).status, 200);
  });
});

test("daily quota caps Google calls and returns 503 without calling Google", async () => {
  await withServer({ config: { dailyGoogleCallLimit: 2 } }, {}, async (s) => {
    assert.equal((await s.call({ body: { ...GOOD, from: "A place" } })).status, 200);
    assert.equal((await s.call({ body: { ...GOOD, from: "B place" } })).status, 200);
    const r = await s.call({ body: { ...GOOD, from: "C place" } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "quota_exceeded");
    assert.ok(Number(r.headers["retry-after"]) >= 60);
    assert.equal(s.google.calls.length, 2);
  });
});

test("cache: identical request is served without a second Google call or quota use", async () => {
  await withServer({ config: { dailyGoogleCallLimit: 1 } }, {}, async (s) => {
    const a = await s.call({ body: GOOD });
    const b = await s.call({ body: { from: "  CHARBAGH   railway station, lucknow ", to: GOOD.to } }); // same place, different spacing/case
    assert.equal(a.json.cached, false);
    assert.equal(b.status, 200);
    assert.equal(b.json.cached, true);
    assert.equal(s.google.calls.length, 1);
    s.clock.t += 121_000; // cache expired, quota (1) is used up
    assert.equal((await s.call({ body: GOOD })).status, 503);
  });
});

test("forecast returns 6 points; partial failures are tolerated", async () => {
  const fail = (args, n) => (!args.full && n === 3 ? new GoogleError("upstream_error", 500, "x") : null);
  await withServer({}, { fail }, async (s) => {
    const r = await s.call({ body: { ...GOOD, forecast: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json.forecast.length, 5);
    // call #1 is the main lookup; call #3 is the +30 min forecast point, which we made fail
    assert.deepEqual(r.json.forecast.map((p) => p.offsetMin), [15, 60, 90, 120, 180]);
    for (const p of r.json.forecast) assert.ok(p.durationSec > 0 && p.freeSec > 0);
  });
});

test("forecast quota denial degrades gracefully: main result still returned", async () => {
  await withServer({ config: { dailyGoogleCallLimit: 3 } }, {}, async (s) => {
    const r = await s.call({ body: { ...GOOD, forecast: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json.forecast, null);
    assert.equal(s.google.calls.length, 1);
  });
});

test("upstream errors never leak the key or internals", async () => {
  const fail = () => new Error(`boom with ${SECRET_KEY} inside and a /home/app/secret/path`);
  await withServer({}, { fail }, async (s) => {
    const r = await s.call({ body: GOOD });
    assert.equal(r.status, 500);
    assert.ok(!r.text.includes(SECRET_KEY));
    assert.ok(!r.text.includes("/home/app"));
    assert.deepEqual(Object.keys(r.json).sort(), ["error", "message"]);
    const logged = JSON.stringify(s.logs);
    assert.ok(!logged.includes(SECRET_KEY), "key must be redacted in logs");
  });
});

test("Google error kinds map to safe statuses", async () => {
  const cases = [
    ["no_route", 404, "no_route"],
    ["upstream_auth", 502, "upstream_error"],
    ["upstream_busy", 503, "upstream_error"],
    ["upstream_error", 502, "upstream_error"],
  ];
  for (const [kind, status, code] of cases) {
    await withServer({}, { fail: () => new GoogleError(kind, 403, "PERMISSION_DENIED") }, async (s) => {
      const r = await s.call({ body: GOOD });
      assert.equal(r.status, status, kind);
      assert.equal(r.json.error, code, kind);
      assert.ok(!r.text.includes("PERMISSION_DENIED"));
    });
  }
});

test("if the store is down the server fails closed and does not call Google", async () => {
  const broken = {
    async init() {}, async close() {}, async ping() { throw new Error("down"); },
    async getCache() { throw new Error("mongo down"); },
    async setCache() { throw new Error("mongo down"); },
    async hit() { throw new Error("mongo down"); },
    async takeQuota() { throw new Error("mongo down"); },
  };
  const google = fakeGoogle();
  await withServer({ store: broken, google }, {}, async (s) => {
    const r = await s.call({ body: GOOD });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "service_unavailable");
    assert.equal(google.calls.length, 0);
    assert.equal((await s.call({ method: "GET", path: "/healthz", origin: null })).status, 503);
  });
});

test("access log never contains request bodies, query strings or IP addresses", async () => {
  await withServer({}, {}, async (s) => {
    await s.call({ body: { from: "Secret Home Address 12", to: "Secret Work Place" } });
    await s.call({ method: "GET", path: "/healthz?token=abc", origin: null });
    const logged = JSON.stringify(s.logs);
    assert.ok(!logged.includes("Secret"));
    assert.ok(!logged.includes("token=abc"));
    assert.ok(!logged.includes("127.0.0.1"));
  });
});
