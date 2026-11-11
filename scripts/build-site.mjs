// Builds the static site into ./_site.
//
//   API_BASE_URL=https://your-backend.example.com \
//   FIREBASE_API_KEY=... FIREBASE_AUTH_DOMAIN=... FIREBASE_PROJECT_ID=... FIREBASE_APP_ID=... \
//   node scripts/build-site.mjs
//
// - Fills in the backend address and the Firebase web settings. None of these is the Google Maps key:
//   that key exists only on the backend and must never be given to this script.
// - Missing settings do NOT stop the build, so the site can always be deployed. The site then shows
//   "API not connected at the backend" (no backend address) or "Sign-in is not set up yet" (no Firebase),
//   and nobody can use it, because there is no way to sign in.
// - A setting that is present but malformed, or half of the Firebase settings, DOES stop the build.
// - Refuses to build if the output contains anything that looks like a secret.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "site";
const OUT = "_site";

function fail(msg) {
  console.error("Build failed: " + msg);
  process.exit(1);
}

const env = (name) => (process.env[name] || "").trim();

const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  console.warn((process.env.GITHUB_ACTIONS ? "::warning::" : "Warning: ") + msg);
};

// ---- backend address (optional) ----
const base = env("API_BASE_URL").replace(/\/+$/, "");
if (!base) {
  warn("API_BASE_URL is not set. The site will show \"API not connected at the backend\" until you set it to your deployed backend's address and deploy again.");
} else {
  let url;
  try { url = new URL(base); } catch { fail("API_BASE_URL is not a valid URL."); }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) fail("API_BASE_URL must use https (http is only allowed for localhost).");
  if (url.origin !== base) fail("API_BASE_URL must be just the origin, with no path, query or trailing slash content (got " + base + ").");
}

// ---- Firebase web settings (public identifiers; all four or none) ----
const fbKey = env("FIREBASE_API_KEY");
const fbDomain = env("FIREBASE_AUTH_DOMAIN");
const fbProject = env("FIREBASE_PROJECT_ID");
const fbApp = env("FIREBASE_APP_ID");
const fbGiven = [fbKey, fbDomain, fbProject, fbApp].filter(Boolean).length;
if (fbGiven === 0) {
  warn("No Firebase settings were given. The site will deploy, but nobody can sign in, so nobody can use it, until you add FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID and FIREBASE_APP_ID.");
} else {
  if (fbGiven < 4) fail("Only some of the four Firebase settings are set. Set all of FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, FIREBASE_APP_ID, or none of them.");
  if (!/^AIza[0-9A-Za-z_-]{35}$/.test(fbKey)) fail("FIREBASE_API_KEY does not look like a Firebase web API key.");
  if (!/^[a-z0-9][a-z0-9.-]{3,60}\.[a-z]{2,}$/.test(fbDomain)) fail("FIREBASE_AUTH_DOMAIN must be a host name such as my-app.firebaseapp.com (no https://, no slash).");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(fbProject)) fail("FIREBASE_PROJECT_ID must be your Firebase project id (lowercase letters, digits, hyphens).");
  if (!/^[0-9]+:[0-9]+:web:[0-9a-f]+$/.test(fbApp)) fail("FIREBASE_APP_ID must look like 1:1234567890:web:abcdef123456 (a *web* app id).");
}

// A key that is named like a backend secret must never be present while building the public site.
for (const name of ["GOOGLE_MAPS_API_KEY", "MONGODB_URI", "IP_HASH_SECRET"]) {
  if (env(name)) fail(`${name} is set in this environment. It belongs on the backend only; remove it from the site build step.`);
}

// A build stamp shown in the page footer, so anyone can tell which version is live.
const sha = env("GITHUB_SHA").slice(0, 7);
const build = (/^[0-9a-f]{7}$/.test(sha) ? sha : "local") + ", " + new Date().toISOString().slice(0, 10);

// Files from the previous version of this project. If they are still in the repo root and GitHub Pages is
// set to "Deploy from a branch", visitors get THESE (dark page asking for a Maps key) instead of this build.
const legacy = ["index.html", "app.js", "style.css", "config.js"].filter((f) => existsSync(f));
if (legacy.length) {
  warn(`Old files from the previous version are still in the repo root (${legacy.join(", ")}). They are not part of the site any more. Delete them, and set Settings > Pages > Source to "GitHub Actions", otherwise visitors may keep seeing the old page.`);
}

const TOKENS = {
  __BUILD__: build,
  __API_BASE__: base,
  __FIREBASE_API_KEY__: fbKey,
  __FIREBASE_AUTH_DOMAIN__: fbDomain,
  __FIREBASE_PROJECT_ID__: fbProject,
  __FIREBASE_APP_ID__: fbApp,
};

if (!existsSync(SRC)) fail("Run this from the project root (folder 'site' not found).");
rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });

for (const f of ["index.html", "config.js"]) {
  const p = join(OUT, f);
  let text = readFileSync(p, "utf8");
  // Drop the allowances for anything that is not configured, so the policy stays as tight as possible.
  if (!base) text = text.split("__API_BASE__ ").join("");
  if (!fbDomain) text = text.split("https://__FIREBASE_AUTH_DOMAIN__ ").join("");
  for (const [token, value] of Object.entries(TOKENS)) text = text.split(token).join(value);
  writeFileSync(p, text);
}

// ---- guards on the finished output ----
// Any Google API key in the page must be exactly the Firebase web key. Anything else
// (for example the Maps key pasted by mistake) stops the build.
const OTHER_SECRETS = [
  [/mongodb(\+srv)?:\/\//i, "a MongoDB connection string"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  // The name GOOGLE_MAPS_API_KEY may appear in help text; an actual key is caught by the AIza scan above.
  [/IP_HASH_SECRET/, "a secret variable name"],
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
  const left = Object.keys(TOKENS).find((t) => text.includes(t));
  if (left) fail(`${file} still contains the placeholder ${left}`);
  for (const k of text.match(/AIza[0-9A-Za-z_-]{20,}/g) || []) {
    if (k !== fbKey) fail(`${file} contains a Google API key that is not the Firebase web key. The Google Maps key must never be in the website.`);
  }
  for (const [re, what] of OTHER_SECRETS) {
    if (re.test(text)) fail(`${file} appears to contain ${what}. Nothing secret may be published on GitHub Pages.`);
  }
}

console.log(`Site built in ${OUT}/ (backend: ${base || "NOT SET"}, Firebase project: ${fbProject || "NOT SET"})` + (warnings.length ? `, ${warnings.length} warning(s)` : ""));
