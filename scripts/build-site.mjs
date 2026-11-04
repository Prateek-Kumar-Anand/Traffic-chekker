// Builds the static site into ./_site.
//
//   API_BASE_URL=https://your-backend.example.com node scripts/build-site.mjs
//
// - Fills in the backend address (public, not a secret) in config.js and the page's CSP.
// - Refuses to build if the output contains anything that looks like a secret.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "site";
const OUT = "_site";
const TOKEN = "__API_BASE__";

function fail(msg) {
  console.error("Build failed: " + msg);
  process.exit(1);
}

const base = (process.env.API_BASE_URL || "").trim().replace(/\/+$/, "");
if (!base) fail("API_BASE_URL is not set. Set it to the origin of your deployed backend, e.g. https://traffic-checker-api.onrender.com");

let url;
try { url = new URL(base); } catch { fail("API_BASE_URL is not a valid URL."); }
const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) fail("API_BASE_URL must use https (http is only allowed for localhost).");
if (url.origin !== base) fail("API_BASE_URL must be just the origin, with no path, query or trailing slash content (got " + base + ").");

if (!existsSync(SRC)) fail("Run this from the project root (folder 'site' not found).");
rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });

for (const f of ["index.html", "config.js"]) {
  const p = join(OUT, f);
  writeFileSync(p, readFileSync(p, "utf8").split(TOKEN).join(base));
}

// Guards on the finished output.
const SECRET_PATTERNS = [
  [/AIza[0-9A-Za-z_-]{30,}/, "a Google API key"],
  [/mongodb(\+srv)?:\/\//i, "a MongoDB connection string"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/IP_HASH_SECRET|GOOGLE_MAPS_API_KEY/, "a secret variable name"],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

for (const file of walk(OUT)) {
  const text = readFileSync(file, "utf8");
  if (text.includes(TOKEN)) fail(`${file} still contains the placeholder ${TOKEN}`);
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(text)) fail(`${file} appears to contain ${what}. Nothing secret may be published on GitHub Pages.`);
  }
}

console.log(`Site built in ${OUT}/ for backend ${base}`);
