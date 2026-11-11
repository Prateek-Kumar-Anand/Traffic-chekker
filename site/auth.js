// Sign-in with Firebase Authentication. This is the only file that talks to Firebase.
//
// - Firebase's web settings are public by design (they identify the project, they do not
//   grant access). What protects the app is the login itself plus the backend, which checks
//   every request's login token before it ever uses the Google Maps key.
// - The Google Maps key is not here and never reaches the browser.
//
// This file exposes window.TCAuth for app.js. If Firebase is not configured or cannot load,
// TCAuth.status says so and app.js shows a clear message instead of a broken page.

const SDK = "https://www.gstatic.com/firebasejs/11.0.2/";
const cfg = (window.APP_CONFIG && window.APP_CONFIG.FIREBASE) || {};
const FIELDS = ["apiKey", "authDomain", "projectId", "appId"];
const configured = FIELDS.every((k) => typeof cfg[k] === "string" && cfg[k].trim() !== "" && cfg[k].indexOf("__") === -1);

const api = { status: configured ? "loading" : "unconfigured" };
window.TCAuth = api;
const LOAD_TIMEOUT_MS = 10000;

function shape(u) {
  return u
    ? { uid: String(u.uid), email: String(u.email || ""), verified: u.emailVerified === true }
    : null;
}

// app.js waits for this before it decides what to show.
window.TCAuthReady = (async function load() {
  if (!configured) return;
  try {
    const [appMod, authMod] = await Promise.race([
      Promise.all([import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js")]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), LOAD_TIMEOUT_MS)),
    ]);
    const app = appMod.initializeApp({
      apiKey: cfg.apiKey,
      authDomain: cfg.authDomain,
      projectId: cfg.projectId,
      appId: cfg.appId,
    });
    const auth = authMod.getAuth(app);

    Object.assign(api, {
      status: "ready",

      // Calls cb(user|null) now and whenever the signed-in user changes.
      onChange(cb) {
        return authMod.onAuthStateChanged(auth, (u) => cb(shape(u)));
      },
      signInWithGoogle() {
        const provider = new authMod.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        return authMod.signInWithPopup(auth, provider);
      },
      signIn(email, password) {
        return authMod.signInWithEmailAndPassword(auth, email, password);
      },
      async signUp(email, password) {
        const cred = await authMod.createUserWithEmailAndPassword(auth, email, password);
        await authMod.sendEmailVerification(cred.user);
        return cred;
      },
      resetPassword(email) {
        return authMod.sendPasswordResetEmail(auth, email);
      },
      resendVerification() {
        if (!auth.currentUser) throw Object.assign(new Error("signed out"), { code: "auth/no-current-user" });
        return authMod.sendEmailVerification(auth.currentUser);
      },
      // Re-reads the account (after the person clicks the link in the email) and refreshes the token.
      async refreshUser() {
        if (!auth.currentUser) return null;
        await auth.currentUser.reload();
        await auth.currentUser.getIdToken(true);
        return shape(auth.currentUser);
      },
      signOut() {
        return authMod.signOut(auth);
      },
      // The login token sent to the backend. The SDK refreshes it automatically when it is about to expire.
      async getToken(forceRefresh) {
        if (!auth.currentUser) throw Object.assign(new Error("signed out"), { code: "auth/no-current-user" });
        return auth.currentUser.getIdToken(forceRefresh === true);
      },
    });
  } catch (e) {
    api.status = "failed";
  }
})();
