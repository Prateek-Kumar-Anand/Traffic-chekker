// MongoDB store. Three small collections, each with a TTL index so old data deletes itself:
//   route_cache  - sanitised Google responses, keyed by a SHA-256 hash (no raw places stored)
//   rate_limits  - per-client and per-account counters, keyed by an HMAC (no raw IPs or user ids stored)
//   quota        - one document per UTC day counting Google calls (spend cap)
//
// Every _id is checked against a strict pattern before it reaches a query, so user-supplied
// text can never become a Mongo operator (NoSQL injection).

const CACHE_KEY = /^[a-f0-9]{64}$/;
const LIMIT_ID = /^[a-f0-9]{32}:\d{1,6}:\d{1,10}$/;
const QUOTA_ID = /^quota:\d{4}-\d{2}-\d{2}$/;

function assertShape(re, v) {
  if (typeof v !== "string" || !re.test(v)) throw new Error("invalid store key");
}

function unwrap(res) {
  // mongodb driver v6 returns the document; v5 returned { value }.
  return res && res.value !== undefined && res.n === undefined ? res.value : res;
}

export async function createMongoStore({ uri, dbName, now = Date.now }) {
  const { MongoClient } = await import("mongodb"); // loaded lazily so tests don't need it
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
    appName: "traffic-checker",
  });
  await client.connect();
  const db = client.db(dbName);
  const cache = db.collection("route_cache");
  const limits = db.collection("rate_limits");
  const quota = db.collection("quota");

  await Promise.all(
    [cache, limits, quota].map((c) => c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }))
  );

  return {
    async init() {},
    async close() { await client.close(); },
    async ping() { await db.command({ ping: 1 }); return true; },

    async getCache(key) {
      assertShape(CACHE_KEY, key);
      const doc = await cache.findOne({ _id: key });
      // The TTL monitor only runs about once a minute, so check expiry ourselves too.
      if (!doc || doc.expiresAt.getTime() <= now()) return null;
      return doc.value;
    },

    async setCache(key, value, ttlSec) {
      assertShape(CACHE_KEY, key);
      await cache.replaceOne(
        { _id: key },
        { _id: key, value, expiresAt: new Date(now() + ttlSec * 1000) },
        { upsert: true }
      );
    },

    async hit(id, windowSec, limit) {
      const nowMs = now();
      const windowIdx = Math.floor(nowMs / 1000 / windowSec);
      const _id = `${id}:${windowSec}:${windowIdx}`;
      assertShape(LIMIT_ID, _id);
      const expiresAt = new Date((windowIdx + 1) * windowSec * 1000 + 60_000);

      let doc;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          doc = unwrap(await limits.findOneAndUpdate(
            { _id },
            { $inc: { n: 1 }, $setOnInsert: { expiresAt } },
            { upsert: true, returnDocument: "after" }
          ));
          break;
        } catch (e) {
          if (e && e.code === 11000 && attempt === 0) continue; // two upserts raced; retry once
          throw e;
        }
      }
      const n = doc && Number.isInteger(doc.n) ? doc.n : limit + 1; // unknown -> fail closed
      return {
        allowed: n <= limit,
        count: n,
        retryAfterSec: Math.max(1, Math.ceil((windowIdx + 1) * windowSec - nowMs / 1000)),
      };
    },

    async takeQuota(day, n, limit) {
      const _id = `quota:${day}`;
      assertShape(QUOTA_ID, _id);
      if (n > limit) return false;
      const expiresAt = new Date(now() + 3 * 24 * 3600 * 1000);
      try {
        // Matches only while used <= limit - n. If the filter fails for an existing day,
        // the upsert tries to insert the same _id and Mongo raises a duplicate-key error,
        // which means "over the limit". The check and the increment are one atomic step.
        await quota.updateOne(
          { _id, used: { $lte: limit - n } },
          { $inc: { used: n }, $setOnInsert: { expiresAt } },
          { upsert: true }
        );
        return true;
      } catch (e) {
        if (e && e.code === 11000) return false;
        throw e;
      }
    },
  };
}
