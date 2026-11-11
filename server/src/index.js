import { loadConfig } from "./config.js";
import { createGoogleClient } from "./google.js";
import { createMongoStore } from "./store-mongo.js";
import { createServer } from "./app.js";
import { createFirebaseVerifier } from "./auth.js";

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

let store;
try {
  store = await createMongoStore({ uri: config.mongoUri, dbName: config.mongoDb });
} catch (e) {
  // Deliberately not printing the error text: it can echo parts of the connection string.
  console.error(`Could not connect to MongoDB (${e && e.name ? e.name : "error"}). Check MONGODB_URI and the Atlas network allowlist.`);
  process.exit(1);
}

// No Maps key is allowed: the backend still runs and answers "API not connected at the backend".
const google = config.googleKey ? createGoogleClient({ apiKey: config.googleKey }) : null;
if (!google) console.warn(JSON.stringify({ level: "warn", msg: "GOOGLE_MAPS_API_KEY is not set: API not connected. Traffic checks will be refused until it is added." }));
if (!config.adminEmails.length) console.warn(JSON.stringify({ level: "warn", msg: "ADMIN_EMAILS is not set: nobody can open the admin console." }));
const auth = createFirebaseVerifier({ projectId: config.firebaseProjectId });
const server = createServer({ config, store, google, auth });

server.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", msg: "listening", port: config.port }));
});

async function shutdown(signal) {
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  server.close(async () => {
    try { await store.close(); } finally { process.exit(0); }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Fail loudly so the host restarts a clean process rather than running in a broken state.
process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection:", e && e.message ? (config.googleKey ? e.message.split(config.googleKey).join("[redacted]") : e.message) : "unknown");
  process.exit(1);
});
