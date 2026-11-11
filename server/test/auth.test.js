import test from "node:test";
import assert from "node:assert/strict";
import { start, GOOD, makeToken, wrongKeyToken, GOOD_TOKEN, PROJECT_ID, KID, PUBLIC_PEM, SECRET_KEY } from "./helpers.js";
import { createFirebaseVerifier, AuthError } from "../src/auth.js";

async function withServer(over, fn) {
  const s = await start(over, {});
  try { await fn(s); } finally { await s.close(); }
}

const NOW = Date.parse("2026-11-04T10:00:00Z");
const sec = Math.floor(NOW / 1000);

test("no token, wrong scheme or garbage: 401 and Google is never called", async () => {
  await withServer({}, async (s) => {
    const none = await s.call({ body: GOOD, token: null });
    assert.equal(none.status, 401);
    assert.equal(none.json.error, "unauthorized");
    assert.equal(none.headers["www-authenticate"], "Bearer");
    for (const authz of ["Basic abc", "Bearer", "Bearer a b", "bearer " + GOOD_TOKEN(), "Bearer <script>", GOOD_TOKEN()]) {
      const r = await s.call({ body: GOOD, token: null, headers: { Authorization: authz } });
      assert.equal(r.status, 401, authz.slice(0, 30));
    }
    assert.equal((await s.call({ body: GOOD, token: "not.a.jwt" })).status, 401);
    assert.equal((await s.call({ body: GOOD, token: "x".repeat(5000) })).status, 401);
    assert.equal(s.google.calls.length, 0);
  });
});

test("a valid token is accepted and the Maps key still never appears in the response", async () => {
  await withServer({}, async (s) => {
    const r = await s.call({ body: GOOD });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(SECRET_KEY));
    assert.equal(s.google.calls.length, 1);
  });
});

test("forged, expired, mis-targeted and tampered tokens are rejected", async () => {
  await withServer({}, async (s) => {
    const bad = {
      "signed with another key": wrongKeyToken(),
      "expired": makeToken({ exp: sec - 3600 }),
      "issued in the future": makeToken({ iat: sec + 3600 }),
      "wrong audience": makeToken({ aud: "other-project" }),
      "wrong issuer": makeToken({ iss: "https://securetoken.google.com/other-project" }),
      "no subject": makeToken({ sub: undefined }),
      "empty subject": makeToken({ sub: "" }),
      "alg none": makeToken({}, { header: { alg: "none" } }),
      "alg HS256": makeToken({}, { header: { alg: "HS256" } }),
      "unknown kid": makeToken({}, { header: { kid: "other" } }),
      "no kid": makeToken({}, { header: { kid: undefined } }),
    };
    for (const [name, token] of Object.entries(bad)) {
      const r = await s.call({ body: GOOD, token });
      assert.equal(r.status, 401, name);
    }
    // flip one character of the payload: the signature no longer matches
    const [h, p, sg] = GOOD_TOKEN().split(".");
    const tampered = [h, p.slice(0, -2) + (p.slice(-2) === "AA" ? "BB" : "AA"), sg].join(".");
    assert.equal((await s.call({ body: GOOD, token: tampered })).status, 401);
    assert.equal(s.google.calls.length, 0);
  });
});

test("unverified email is refused with 403 so throwaway accounts cannot spend the quota", async () => {
  await withServer({}, async (s) => {
    const r = await s.call({ body: GOOD, token: makeToken({ email_verified: false, firebase: { sign_in_provider: "password" } }) });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "email_not_verified");
    assert.equal(s.google.calls.length, 0);
  });
});

test("auth failures reveal nothing about why", async () => {
  await withServer({}, async (s) => {
    const r = await s.call({ body: GOOD, token: makeToken({ aud: "other-project" }) });
    assert.deepEqual(Object.keys(r.json).sort(), ["error", "message"]);
    assert.ok(!/audience|signature|kid|issuer/i.test(r.text));
    assert.ok(!JSON.stringify(s.logs).includes(GOOD_TOKEN()));
  });
});

test("CORS preflight allows the Authorization header", async () => {
  await withServer({}, async (s) => {
    const pre = await s.call({ method: "OPTIONS", token: null });
    assert.equal(pre.status, 204);
    assert.match(pre.headers["access-control-allow-headers"], /Authorization/);
  });
});

test("per-account rate limit holds even when the IP changes", async () => {
  await withServer({ config: { userRateLimitPerMin: 2, trustProxyHops: 1 } }, async (s) => {
    const alice = GOOD_TOKEN();
    const bob = makeToken({ sub: "user-bob" });
    const via = (ip, token, from) => s.call({ token, body: { ...GOOD, from }, headers: { "X-Forwarded-For": ip + ", 10.0.0.1" } });
    assert.equal((await via("1.1.1.1", alice, "Place A")).status, 200);
    assert.equal((await via("2.2.2.2", alice, "Place B")).status, 200);
    // same account, brand-new IP: still limited
    const r = await via("3.3.3.3", alice, "Place C");
    assert.equal(r.status, 429);
    assert.equal(r.json.error, "rate_limited");
    // another account is unaffected (IP limiter is the default 10/min and has seen 3 hits from 10.0.0.1)
    assert.equal((await via("4.4.4.4", bob, "Place D")).status, 200);
  });
});

test("unauthenticated requests do not touch the database", async () => {
  let touched = 0;
  const spy = new Proxy({}, { get: () => async () => { touched++; return { allowed: true }; } });
  await withServer({ store: spy }, async (s) => {
    assert.equal((await s.call({ body: GOOD, token: null })).status, 401);
    assert.equal((await s.call({ body: GOOD, token: wrongKeyToken() })).status, 401);
    assert.equal(touched, 0);
  });
});

test("verifier: certificates are cached, and a rotated key is picked up at most once a minute", async () => {
  let t = NOW;
  let fetches = 0;
  let certs = { [KID]: PUBLIC_PEM };
  const v = createFirebaseVerifier({ projectId: PROJECT_ID, now: () => t, fetchCerts: async () => { fetches++; return { certs, maxAgeSec: 3600 }; } });
  const tok = () => makeToken({}, { now: t });
  await v.verify(tok());
  await v.verify(tok());
  assert.equal(fetches, 1);

  // unknown kid right after a fetch: no extra download
  await assert.rejects(v.verify(makeToken({}, { header: { kid: "new" }, now: t })), (e) => e instanceof AuthError && e.kind === "unauthorized");
  assert.equal(fetches, 1);

  // a minute later the same unknown kid triggers one refresh; the key has rotated in
  t += 61_000;
  certs = { [KID]: PUBLIC_PEM, new: PUBLIC_PEM };
  await v.verify(makeToken({}, { header: { kid: "new" }, now: t }));
  assert.equal(fetches, 2);

  // cache expiry
  t += 3601 * 1000;
  await v.verify(tok());
  assert.equal(fetches, 3);
});

test("verifier: if Google's certificates cannot be fetched, the result is 'unavailable', not a pass", async () => {
  const v = createFirebaseVerifier({ projectId: PROJECT_ID, now: () => NOW, fetchCerts: async () => { throw new Error("offline"); } });
  await assert.rejects(v.verify(GOOD_TOKEN()), (e) => e instanceof AuthError && e.kind === "unavailable");

  await withServer({ auth: v }, async (s) => {
    const r = await s.call({ body: GOOD });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "service_unavailable");
    assert.equal(s.google.calls.length, 0);
  });
});

test("verifier: clock skew of up to a minute is tolerated, more is not", async () => {
  const v = createFirebaseVerifier({ projectId: PROJECT_ID, now: () => NOW, fetchCerts: async () => ({ certs: { [KID]: PUBLIC_PEM }, maxAgeSec: 3600 }) });
  await v.verify(makeToken({ iat: sec + 30 }));
  await assert.rejects(v.verify(makeToken({ iat: sec + 120 })));
  await v.verify(makeToken({ exp: sec - 30 }));
  await assert.rejects(v.verify(makeToken({ exp: sec - 120 })));
});
