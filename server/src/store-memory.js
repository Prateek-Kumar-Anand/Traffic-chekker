// In-memory store with the same behaviour as the MongoDB store. Used by the tests
// and handy for trying the server locally without a database. Not for production:
// it is per-process and forgets everything on restart.

export function createMemoryStore({ now = Date.now } = {}) {
  const cache = new Map();   // key -> { value, expiresAt }
  const limits = new Map();  // id  -> { n, expiresAt }
  const quota = new Map();   // day -> { used }
  const users = new Map();   // uid -> user record

  return {
    async init() {},
    async close() {},
    async ping() { return true; },

    async getCache(key) {
      const e = cache.get(key);
      if (!e || e.expiresAt <= now()) { cache.delete(key); return null; }
      return structuredClone(e.value);
    },

    async setCache(key, value, ttlSec) {
      cache.set(key, { value: structuredClone(value), expiresAt: now() + ttlSec * 1000 });
    },

    // Fixed-window counter. Counts every attempt, allowed or not.
    async hit(id, windowSec, limit) {
      const nowMs = now();
      const windowIdx = Math.floor(nowMs / 1000 / windowSec);
      const _id = `${id}:${windowSec}:${windowIdx}`;
      const e = limits.get(_id) || { n: 0, expiresAt: (windowIdx + 1) * windowSec * 1000 + 60_000 };
      e.n += 1;
      limits.set(_id, e);
      return {
        allowed: e.n <= limit,
        count: e.n,
        retryAfterSec: Math.max(1, Math.ceil((windowIdx + 1) * windowSec - nowMs / 1000)),
      };
    },

    // ---- people who have signed in (for the admin console and for blocking) ----

    // Creates or updates the record and returns a copy. Sign-in details are refreshed every time;
    // `blocked` is never changed here.
    async touchUser({ uid, email, provider }, { countRequest = false } = {}) {
      const t = new Date(now()).toISOString();
      const u = users.get(uid) || { uid, email: "", provider: "", createdAt: t, lastSeenAt: t, requests: 0, blocked: false };
      u.email = email;
      u.provider = provider;
      u.lastSeenAt = t;
      if (countRequest) u.requests += 1;
      users.set(uid, u);
      return { ...u };
    },

    async getUser(uid) {
      const u = users.get(uid);
      return u ? { ...u } : null;
    },

    // Most recently active first.
    async listUsers(limit) {
      return [...users.values()]
        .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0))
        .slice(0, limit)
        .map((u) => ({ ...u }));
    },

    async userCounts() {
      let blocked = 0;
      for (const u of users.values()) if (u.blocked) blocked++;
      return { total: users.size, blocked };
    },

    // Returns the updated record, or null when nobody with that id has signed in yet.
    async setBlocked(uid, blocked) {
      const u = users.get(uid);
      if (!u) return null;
      u.blocked = blocked === true;
      return { ...u };
    },

    async getQuotaUsed(day) {
      return (quota.get(day) || { used: 0 }).used;
    },

    // Atomically reserve n Google calls for the day; false when it would exceed the limit.
    async takeQuota(day, n, limit) {
      if (n > limit) return false;
      const e = quota.get(day) || { used: 0 };
      if (e.used > limit - n) return false;
      e.used += n;
      quota.set(day, e);
      return true;
    },
  };
}
