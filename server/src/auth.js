// Verifies Firebase Authentication ID tokens without any third-party package.
//
// A Firebase ID token is an RS256-signed JWT. Google publishes the matching public
// certificates, so we can check the signature and claims locally:
//   https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
//
// The token proves who is calling. It carries no secret and is never logged.

import crypto from "node:crypto";

export const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const MAX_TOKEN_CHARS = 4096;
const CLOCK_SKEW_SEC = 60;
const MIN_REFETCH_MS = 60_000; // an unknown key id can trigger at most one certificate download a minute
const B64URL = /^[A-Za-z0-9_-]+$/;

// kind: "unauthorized" (401) | "unverified" (403, email not confirmed) | "unavailable" (503, cannot fetch certs)
export class AuthError extends Error {
  constructor(kind, detail) {
    super(`auth ${kind}: ${detail}`);
    this.kind = kind;
  }
}

function b64urlToBuffer(s) {
  if (!B64URL.test(s)) throw new AuthError("unauthorized", "malformed token");
  return Buffer.from(s, "base64url");
}

function parseJson(buf) {
  try {
    const v = JSON.parse(buf.toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new AuthError("unauthorized", "malformed token");
  }
}

async function defaultFetchCerts() {
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!res.ok) throw new Error("certificate download failed with http " + res.status);
  const cc = /max-age=(\d+)/.exec(res.headers.get("cache-control") || "");
  const certs = await res.json();
  return { certs, maxAgeSec: cc ? Number(cc[1]) : 3600 };
}

export function createFirebaseVerifier({ projectId, fetchCerts = defaultFetchCerts, now = Date.now }) {
  if (!projectId) throw new Error("projectId is required");
  const issuer = "https://securetoken.google.com/" + projectId;

  let keys = new Map();       // kid -> KeyObject
  let expiresAt = 0;
  let lastFetch = 0;
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        lastFetch = now();
        const { certs, maxAgeSec } = await fetchCerts();
        const next = new Map();
        for (const [kid, pem] of Object.entries(certs || {})) {
          try { next.set(kid, crypto.createPublicKey(pem)); } catch { /* skip an unreadable entry */ }
        }
        if (!next.size) throw new Error("no usable certificates");
        keys = next;
        expiresAt = now() + Math.max(60, maxAgeSec) * 1000;
      } catch (e) {
        throw new AuthError("unavailable", e && e.message ? e.message : "certificate fetch failed");
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid) {
    if (!keys.size || now() >= expiresAt) await refresh();
    let key = keys.get(kid);
    if (!key && now() - lastFetch >= MIN_REFETCH_MS) {
      await refresh(); // keys rotate; look once more before rejecting
      key = keys.get(kid);
    }
    return key || null;
  }

  // Returns { uid, email, emailVerified, provider } or throws AuthError.
  async function verify(token, { requireVerifiedEmail = true } = {}) {
    if (typeof token !== "string" || token.length < 20 || token.length > MAX_TOKEN_CHARS) {
      throw new AuthError("unauthorized", "bad token size");
    }
    const parts = token.split(".");
    if (parts.length !== 3) throw new AuthError("unauthorized", "malformed token");

    const header = parseJson(b64urlToBuffer(parts[0]));
    const claims = parseJson(b64urlToBuffer(parts[1]));
    const signature = b64urlToBuffer(parts[2]);

    // Only RS256. Rejecting everything else closes the "alg: none" and HS256 key-confusion tricks.
    if (header.alg !== "RS256") throw new AuthError("unauthorized", "unsupported algorithm");
    if (typeof header.kid !== "string" || header.kid.length > 100) throw new AuthError("unauthorized", "missing key id");

    const key = await keyFor(header.kid);
    if (!key) throw new AuthError("unauthorized", "unknown signing key");

    const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, signature);
    if (!ok) throw new AuthError("unauthorized", "bad signature");

    const nowSec = Math.floor(now() / 1000);
    const isNum = (v) => typeof v === "number" && Number.isFinite(v);
    if (!isNum(claims.exp) || claims.exp <= nowSec - CLOCK_SKEW_SEC) throw new AuthError("unauthorized", "token expired");
    if (!isNum(claims.iat) || claims.iat > nowSec + CLOCK_SKEW_SEC) throw new AuthError("unauthorized", "token issued in the future");
    if (isNum(claims.auth_time) && claims.auth_time > nowSec + CLOCK_SKEW_SEC) throw new AuthError("unauthorized", "bad auth_time");
    if (claims.aud !== projectId) throw new AuthError("unauthorized", "wrong audience");
    if (claims.iss !== issuer) throw new AuthError("unauthorized", "wrong issuer");
    if (typeof claims.sub !== "string" || !/^[A-Za-z0-9_:.-]{1,128}$/.test(claims.sub)) throw new AuthError("unauthorized", "bad subject");

    const emailVerified = claims.email_verified === true;
    if (requireVerifiedEmail && !emailVerified) throw new AuthError("unverified", "email not verified");

    return {
      uid: claims.sub,
      email: typeof claims.email === "string" ? claims.email.slice(0, 254) : "",
      emailVerified,
      provider: claims.firebase && typeof claims.firebase.sign_in_provider === "string" ? claims.firebase.sign_in_provider : "",
    };
  }

  return { verify };
}
