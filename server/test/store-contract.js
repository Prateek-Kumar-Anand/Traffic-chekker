import assert from "node:assert/strict";

// Behaviour every store (memory or MongoDB) must have. `make` returns { store, clock }.
export function storeContract(test, name, make) {
  const KEY = "a".repeat(64);
  const ID = "b".repeat(32);

  test(`${name}: cache stores, returns a copy, and expires`, async () => {
    const { store, clock, done } = await make();
    try {
      assert.equal(await store.getCache(KEY), null);
      await store.setCache(KEY, { a: 1 }, 60);
      assert.deepEqual(await store.getCache(KEY), { a: 1 });
      clock.t += 61_000;
      assert.equal(await store.getCache(KEY), null);
    } finally { await done(); }
  });

  test(`${name}: rate counter allows up to the limit, then blocks, then resets next window`, async () => {
    const { store, clock, done } = await make();
    try {
      for (let i = 1; i <= 3; i++) assert.equal((await store.hit(ID, 60, 3)).allowed, true, `hit ${i}`);
      const blocked = await store.hit(ID, 60, 3);
      assert.equal(blocked.allowed, false);
      assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
      clock.t += 61_000;
      assert.equal((await store.hit(ID, 60, 3)).allowed, true);
    } finally { await done(); }
  });

  test(`${name}: counters are independent per client`, async () => {
    const { store, done } = await make();
    try {
      await store.hit(ID, 60, 1);
      assert.equal((await store.hit(ID, 60, 1)).allowed, false);
      assert.equal((await store.hit("c".repeat(32), 60, 1)).allowed, true);
    } finally { await done(); }
  });

  test(`${name}: quota is all-or-nothing and never exceeds the limit`, async () => {
    const { store, done } = await make();
    try {
      assert.equal(await store.takeQuota("2026-11-04", 6, 10), true);
      assert.equal(await store.takeQuota("2026-11-04", 6, 10), false); // would make 12
      assert.equal(await store.takeQuota("2026-11-04", 4, 10), true);  // exactly 10
      assert.equal(await store.takeQuota("2026-11-04", 1, 10), false);
      assert.equal(await store.takeQuota("2026-11-05", 1, 10), true);  // new day
      assert.equal(await store.takeQuota("2026-11-06", 11, 10), false); // bigger than limit
    } finally { await done(); }
  });

  test(`${name}: concurrent quota requests cannot overspend`, async () => {
    const { store, done } = await make();
    try {
      const results = await Promise.all(Array.from({ length: 30 }, () => store.takeQuota("2026-11-04", 1, 10)));
      assert.equal(results.filter(Boolean).length, 10);
    } finally { await done(); }
  });

  test(`${name}: users are created on first sight, updated after, and never unblocked by a visit`, async () => {
    const { store, clock, done } = await make();
    try {
      const who = { uid: "user-1", email: "a@example.com", provider: "google.com" };
      const first = await store.touchUser(who);
      assert.equal(first.uid, "user-1");
      assert.equal(first.blocked, false);
      assert.equal(first.requests, 0);
      assert.equal(await store.getUser("nobody"), null);

      clock.t += 5000;
      const counted = await store.touchUser({ ...who, email: "new@example.com" }, { countRequest: true });
      assert.equal(counted.requests, 1);
      assert.equal(counted.email, "new@example.com");
      assert.equal(counted.createdAt, first.createdAt);
      assert.ok(counted.lastSeenAt > first.lastSeenAt);

      const blocked = await store.setBlocked("user-1", true);
      assert.equal(blocked.blocked, true);
      assert.equal((await store.touchUser(who)).blocked, true); // a visit does not clear the block
      assert.equal((await store.setBlocked("user-1", false)).blocked, false);
      assert.equal(await store.setBlocked("nobody", true), null);
    } finally { await done(); }
  });

  test(`${name}: user list is newest-activity first, limited, and counted`, async () => {
    const { store, clock, done } = await make();
    try {
      for (const id of ["u1", "u2", "u3"]) {
        await store.touchUser({ uid: id, email: id + "@example.com", provider: "password" });
        clock.t += 1000;
      }
      await store.setBlocked("u2", true);
      const list = await store.listUsers(2);
      assert.deepEqual(list.map((u) => u.uid), ["u3", "u2"]);
      assert.deepEqual(await store.userCounts(), { total: 3, blocked: 1 });
    } finally { await done(); }
  });

  test(`${name}: quota usage can be read`, async () => {
    const { store, done } = await make();
    try {
      assert.equal(await store.getQuotaUsed("2026-11-04"), 0);
      await store.takeQuota("2026-11-04", 3, 10);
      assert.equal(await store.getQuotaUsed("2026-11-04"), 3);
    } finally { await done(); }
  });
}
