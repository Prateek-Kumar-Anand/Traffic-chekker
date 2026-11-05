// The GitHub Actions deploy workflow replaces the placeholder below with the
// GOOGLE_MAPS_API_KEY repository secret. If it is left as-is, the site asks
// each visitor for their own key and stores it in their browser.
window.APP_CONFIG = {
  GOOGLE_MAPS_API_KEY: "__GOOGLE_MAPS_API_KEY__"
};
