// Public settings only. This file never contains a secret, and it never contains the Google Maps key
// (that lives only on the backend).
//
// The placeholders below are replaced at build time by scripts/build-site.mjs, from GitHub Actions
// secrets (see the README):
//   API_BASE  - address of the Traffic Checker backend, e.g. https://traffic-checker-api.onrender.com
//   FIREBASE  - your Firebase web app settings (Firebase console > Project settings > Your apps)
window.APP_CONFIG = {
  API_BASE: "__API_BASE__",
  FIREBASE: {
    apiKey: "__FIREBASE_API_KEY__",
    authDomain: "__FIREBASE_AUTH_DOMAIN__",
    projectId: "__FIREBASE_PROJECT_ID__",
    appId: "__FIREBASE_APP_ID__"
  }
};
