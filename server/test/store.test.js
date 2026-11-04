import test from "node:test";
import { createMemoryStore } from "../src/store-memory.js";
import { storeContract } from "./store-contract.js";

storeContract(test, "memory store", async () => {
  const clock = { t: Date.parse("2026-11-04T10:00:00Z") };
  return { store: createMemoryStore({ now: () => clock.t }), clock, done: async () => {} };
});

// Runs the same contract against a real MongoDB when one is provided, e.g.
//   MONGODB_TEST_URI="mongodb://127.0.0.1:27017" npm test
const uri = process.env.MONGODB_TEST_URI;
if (uri) {
  const { createMongoStore } = await import("../src/store-mongo.js");
  storeContract(test, "mongo store", async () => {
    const clock = { t: Date.now() };
    const dbName = "tc_test_" + Math.random().toString(36).slice(2, 10);
    const store = await createMongoStore({ uri, dbName, now: () => clock.t });
    return {
      store, clock,
      done: async () => {
        const { MongoClient } = await import("mongodb");
        const c = new MongoClient(uri);
        await c.connect();
        await c.db(dbName).dropDatabase();
        await c.close();
        await store.close();
      },
    };
  });
} else {
  test("mongo store contract (skipped: set MONGODB_TEST_URI to run it)", { skip: true }, () => {});
}
