import http from "node:http";
import { createServer } from "../src/app.js";
import { createMemoryStore } from "../src/store-memory.js";
import { loadConfig } from "../src/config.js";

export const SECRET_KEY = "AIzaSy-TEST-SECRET-KEY-0123456789";
export const ORIGIN = "https://alice.github.io";

export function makeConfig(over = {}) {
  return Object.freeze({
    ...loadConfig({
      GOOGLE_MAPS_API_KEY: SECRET_KEY,
      MONGODB_URI: "mongodb://unused",
      IP_HASH_SECRET: "x".repeat(40),
      ALLOWED_ORIGINS: ORIGIN,
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
  const config = makeConfig(over.config || {});
  const server = createServer({ config, store, google, now, log: (e) => logs.push(e) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    server, store, google, clock, logs, config, port,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    call: (opts) => call(port, opts),
  };
}

export function call(port, { method = "POST", path = "/api/route", headers = {}, body, raw, origin = ORIGIN, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (origin) h.Origin = origin;
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
