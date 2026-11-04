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
}
