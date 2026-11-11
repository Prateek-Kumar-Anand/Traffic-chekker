import test from "node:test";
import assert from "node:assert/strict";
import { start, GOOD, makeToken, GOOD_TOKEN, fakeGoogle } from "./helpers.js";

const ADMIN = { sub: "admin-1", email: "Boss@Example.com" };      // mixed case on purpose
const adminTok = () => makeToken(ADMIN);
const bobTok = () => makeToken({ sub: "user-bob", email: "bob@example.com" });
const cfg = { adminEmails: ["boss@example.com"] };

async function withServer(over, fn) {
  const s = await start(over, {});
  try { await fn(s); } finally { await s.close(); }
}
const api = (s, path, token, body) => s.call({ path, token, body: body === undefined ? {} : body });

test("API not connected: with no Maps key the route answers 503 api_not_connected and spends nothing", async () => {
  await withServer({ google: null, config: cfg }, async (s) => {
    const r = await s.call({ body: GOOD });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "api_not_connected");
    assert.match(r.json.message, /API not connected at the backend/);
    assert.equal(await s.store.getQuotaUsed("2026-11-04"), 0);
    // still needs a login: anonymous callers get 401, not a hint about the backend
    assert.equal((await s.call({ body: GOOD, token: null })).status, 401);
  });
});

test("API not connected: a rejected Maps key is reported the same way and the key is not leaked", async () => {
  const { GoogleError } = await import("../src/google.js");
  const s = await start({ config: cfg }, { fail: () => new GoogleError("upstream_auth", 403, "REQUEST_DENIED") });
  try {
    const r = await s.call({ body: GOOD });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "api_not_connected");
    assert.ok(!r.text.includes("REQUEST_DENIED"));
  } finally { await s.close(); }
});

test("logging works with no Maps key configured (nothing is mangled)", async () => {
  await withServer({ google: null, config: { ...cfg, googleKey: "" } }, async (s) => {
    await s.call({ body: GOOD });
    const line = s.logs.find((l) => l.path === "/api/route");
    assert.ok(line, "request is logged");
    assert.equal(line.status, 503);
  });
});

test("/api/me needs a login and tells users and admins apart (email match is case-insensitive)", async () => {
  await withServer({ config: cfg }, async (s) => {
    assert.equal((await api(s, "/api/me", null)).status, 401);

    const user = await api(s, "/api/me", bobTok());
    assert.equal(user.status, 200);
    assert.deepEqual(user.json, { role: "user", email: "bob@example.com", mapsConnected: true });

    const admin = await api(s, "/api/me", adminTok());
    assert.equal(admin.json.role, "admin");
  });
});

test("/api/me reports whether the Maps API is connected", async () => {
  await withServer({ google: null, config: cfg }, async (s) => {
    assert.equal((await api(s, "/api/me", bobTok())).json.mapsConnected, false);
  });
});

test("an unconfirmed email can never be an admin, even with the admin's address", async () => {
  await withServer({ config: cfg }, async (s) => {
    const r = await api(s, "/api/me", makeToken({ ...ADMIN, email_verified: false, firebase: { sign_in_provider: "password" } }));
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "email_not_verified");
    const o = await api(s, "/api/admin/overview", makeToken({ ...ADMIN, email_verified: false }));
    assert.equal(o.status, 403);
  });
});

test("with no ADMIN_EMAILS nobody is an admin", async () => {
  await withServer({}, async (s) => {
    assert.equal((await api(s, "/api/me", adminTok())).json.role, "user");
    assert.equal((await api(s, "/api/admin/users", adminTok())).status, 403);
  });
});

test("admin endpoints: anonymous gets 401, ordinary users get 403, nothing leaks", async () => {
  await withServer({ config: cfg }, async (s) => {
    for (const path of ["/api/admin/overview", "/api/admin/users", "/api/admin/block"]) {
      assert.equal((await api(s, path, null)).status, 401, path);
      const r = await api(s, path, bobTok(), { uid: "user-bob", blocked: true });
      assert.equal(r.status, 403, path);
      assert.equal(r.json.error, "forbidden");
    }
    assert.equal((await s.store.getUser("user-bob")).blocked, false);
  });
});

test("admin overview shows connection status, usage and user counts", async () => {
  await withServer({ config: { ...cfg, dailyGoogleCallLimit: 500 } }, async (s) => {
    await s.call({ body: GOOD, token: bobTok() });                 // 1 main + 6 forecast calls
    const r = await api(s, "/api/admin/overview", adminTok());
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.api, { maps: true, database: true });
    assert.equal(r.json.usage.dailyLimit, 500);
    assert.equal(r.json.usage.day, "2026-11-04");
    assert.ok(r.json.usage.googleCallsToday >= 1);
    assert.equal(r.json.users.total, 2);   // bob and the admin
    assert.equal(r.json.admins, 1);
  });
});

test("admin overview reports a disconnected Maps API", async () => {
  await withServer({ google: null, config: cfg }, async (s) => {
    const r = await api(s, "/api/admin/overview", adminTok());
    assert.equal(r.json.api.maps, false);
  });
});

test("admin can list users (newest first), flagged with who is an admin", async () => {
  await withServer({ config: cfg }, async (s) => {
    await s.call({ body: GOOD, token: bobTok() });
    s.clock.t += 5000;
    await api(s, "/api/me", adminTok());
    const r = await api(s, "/api/admin/users", adminTok());
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.users.map((u) => u.email), ["Boss@Example.com", "bob@example.com"]);
    assert.equal(r.json.users[0].isAdmin, true);
    assert.equal(r.json.users[1].isAdmin, false);
    assert.equal(r.json.users[1].requests, 1);
    assert.equal(r.json.truncated, false);
  });
});

test("blocking: a blocked user is refused at once, Google is not called, and unblocking restores access", async () => {
  await withServer({ config: cfg }, async (s) => {
    assert.equal((await s.call({ body: GOOD, token: bobTok() })).status, 200);
    const calls = s.google.calls.length;

    const blocked = await api(s, "/api/admin/block", adminTok(), { uid: "user-bob", blocked: true });
    assert.equal(blocked.status, 200);
    assert.deepEqual(blocked.json, { uid: "user-bob", blocked: true });

    // same, still-valid token: refused on the very next call
    const refused = await s.call({ body: { ...GOOD, from: "Somewhere else" }, token: bobTok() });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, "account_blocked");
    assert.equal((await api(s, "/api/me", bobTok())).json.error, "account_blocked");
    assert.equal(s.google.calls.length, calls);

    const list = (await api(s, "/api/admin/users", adminTok())).json.users;
    assert.equal(list.find((u) => u.uid === "user-bob").blocked, true);

    assert.equal((await api(s, "/api/admin/block", adminTok(), { uid: "user-bob", blocked: false })).status, 200);
    assert.equal((await s.call({ body: { ...GOOD, from: "Another place" }, token: bobTok() })).status, 200);
  });
});

test("blocking: admins cannot be blocked, unknown people give 404, and bad input is rejected", async () => {
  await withServer({ config: cfg }, async (s) => {
    await api(s, "/api/me", adminTok());
    await api(s, "/api/me", bobTok());
    const self = await api(s, "/api/admin/block", adminTok(), { uid: "admin-1", blocked: true });
    assert.equal(self.status, 400);
    assert.equal(self.json.error, "cannot_block_admin");
    assert.equal((await api(s, "/api/me", adminTok())).status, 200);

    assert.equal((await api(s, "/api/admin/block", adminTok(), { uid: "never-seen", blocked: true })).status, 404);

    const bad = [
      {}, { uid: "user-bob" }, { blocked: true },
      { uid: "user-bob", blocked: "yes" },
      { uid: "user-bob", blocked: 1 },
      { uid: { $ne: "" }, blocked: true },                // NoSQL operator injection
      { uid: "bad uid!", blocked: true },
      { uid: "x".repeat(200), blocked: true },
      { uid: "user-bob", blocked: true, extra: 1 },
      [], "text", null,
    ];
    for (const b of bad) assert.equal((await api(s, "/api/admin/block", adminTok(), b)).status, 400, JSON.stringify(b));
    assert.equal((await s.store.getUser("user-bob")).blocked, false);
  });
});

test("an admin who was somehow flagged blocked is still let in (no lock-out)", async () => {
  await withServer({ config: cfg }, async (s) => {
    await api(s, "/api/me", adminTok());
    await s.store.setBlocked("admin-1", true);
    assert.equal((await api(s, "/api/me", adminTok())).status, 200);
  });
});

test("blocking is checked on the light endpoints too, and CORS still applies to admin endpoints", async () => {
  await withServer({ config: cfg }, async (s) => {
    const r = await s.call({ path: "/api/admin/users", token: adminTok(), origin: "https://evil.example", body: {} });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "forbidden_origin");
    const pre = await s.call({ method: "OPTIONS", path: "/api/admin/block", token: null });
    assert.equal(pre.status, 204);
    const get = await s.call({ method: "GET", path: "/api/admin/users", token: adminTok() });
    assert.equal(get.status, 405);
  });
});

test("the light endpoints have their own, looser rate limit that does not eat the traffic-check budget", async () => {
  await withServer({ config: { ...cfg, rateLimitPerMin: 2, userRateLimitPerMin: 2, miscRateLimitPerMin: 5 } }, async (s) => {
    for (let i = 0; i < 5; i++) assert.equal((await api(s, "/api/me", bobTok())).status, 200, "me " + i);
    assert.equal((await api(s, "/api/me", bobTok())).status, 429);
    // traffic checks have a separate bucket and are still allowed
    assert.equal((await s.call({ body: GOOD, token: bobTok() })).status, 200);
  });
});

test("unknown paths are still 404 and the stores see no admin data without auth", async () => {
  await withServer({ config: cfg }, async (s) => {
    assert.equal((await s.call({ path: "/api/admin", token: null, body: {} })).status, 404);
    assert.equal((await s.call({ path: "/api/admin/delete", token: adminTok(), body: {} })).status, 404);
  });
});
