"use strict";

(function () {
  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const KEY_STORE = "trafficChecker.apiKey";
  const FORECAST_OFFSETS_MIN = [15, 30, 60, 90, 120, 180];
  const REFRESH_MS = 5 * 60 * 1000;
  const MAIN_FIELDS = [
    "durationMillis", "staticDurationMillis", "distanceMeters",
    "path", "viewport", "description", "legs", "speedPaths"
  ];

  function storeGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtDur(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return "< 1 min";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (!h) return m + " min";
    return m ? h + " hr " + m + " min" : h + " hr";
  }

  function fmtDelay(ms) {
    return ms < 30000 ? "No delay" : fmtDur(ms);
  }

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function fmtKm(m) {
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + " km";
  }

  // Traffic level from ratio = (time with traffic) / (time with no traffic)
  function levelOf(ratio) {
    if (ratio < 1.1) return { key: "ok", name: "Clear", note: "Roads are flowing normally." };
    if (ratio < 1.25) return { key: "light", name: "Light traffic", note: "Minor slowdowns on the way." };
    if (ratio < 1.5) return { key: "mid", name: "Moderate traffic", note: "Noticeable slowdowns. Allow extra time." };
    if (ratio < 2) return { key: "heavy", name: "Heavy traffic", note: "Significant jam on this route." };
    return { key: "severe", name: "Severe jam", note: "Very slow. The trip takes more than twice as long as normal." };
  }

  function parsePlace(text) {
    const t = text.trim();
    const m = t.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
    return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : t;
  }

  // ---------- state ----------
  const cfg = window.APP_CONFIG || {};
  const builtInKey = cfg.GOOGLE_MAPS_API_KEY && cfg.GOOGLE_MAPS_API_KEY.indexOf("__") !== 0
    ? cfg.GOOGLE_MAPS_API_KEY : "";
  const apiKey = builtInKey || storeGet(KEY_STORE);

  let mapsReady = null;
  let map = null;
  let RouteClass = null;
  let trafficLayer = null;
  let overlays = [];
  let refreshTimer = null;
  let runToken = 0;

  const state = { routes: [], selected: 0, depart: null, origin: "", dest: "" };

  // ---------- UI helpers ----------
  function showError(msg) {
    const el = $("#error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  function setBusy(busy) {
    const btn = $("#go");
    btn.disabled = busy;
    btn.textContent = busy ? "Checking..." : "Check traffic";
  }

  function explain(err) {
    const msg = (err && err.message) ? err.message : String(err);
    if (/not (been )?enabled|PERMISSION_DENIED|API key|REQUEST_DENIED|403/i.test(msg)) {
      return msg + " Check that your key is valid, that Maps JavaScript API and Routes API are enabled for it, and that its website restrictions allow this page.";
    }
    if (/ZERO_RESULTS|NOT_FOUND|no route/i.test(msg)) {
      return "Google could not find a driving route between those two places. Try adding the city name.";
    }
    return msg;
  }

  // ---------- Google Maps loading ----------
  function loadScript(key) {
    return new Promise((resolve, reject) => {
      if (window.google && google.maps && google.maps.importLibrary) { resolve(); return; }
      window.__mapsReady = resolve;
      window.gm_authFailure = function () {
        showError("Google rejected the API key. Check the key, its website restrictions, and that Maps JavaScript API and Routes API are enabled.");
        setBusy(false);
      };
      const s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) +
        "&v=weekly&loading=async&callback=__mapsReady";
      s.async = true;
      s.onerror = () => reject(new Error("Could not load the Google Maps script. Check your internet connection."));
      document.head.appendChild(s);
    });
  }

  async function initMap() {
    const mapLib = await google.maps.importLibrary("maps");
    await google.maps.importLibrary("marker");
    const routesLib = await google.maps.importLibrary("routes");
    RouteClass = routesLib.Route;

    const mapEl = $("#map");
    mapEl.textContent = "";
    mapEl.style.display = "block";
    map = new mapLib.Map(mapEl, {
      center: { lat: 22.5, lng: 79 },
      zoom: 5,
      mapId: "DEMO_MAP_ID",
      mapTypeControl: false,
      streetViewControl: false
    });
    trafficLayer = new mapLib.TrafficLayer();
    trafficLayer.setMap($("#layer-toggle").checked ? map : null);
  }

  function ensureMaps() {
    if (mapsReady) return mapsReady;
    mapsReady = (async () => {
      await loadScript(apiKey);
      await initMap();
    })();
    mapsReady.catch(() => { mapsReady = null; });
    return mapsReady;
  }

  // ---------- routing ----------
  function request(depart, fields, extra) {
    const r = {
      origin: parsePlace(state.origin),
      destination: parsePlace(state.dest),
      travelMode: "DRIVING",
      routingPreference: "TRAFFIC_AWARE_OPTIMAL",
      fields: fields
    };
    if (depart) r.departureTime = depart;
    return Object.assign(r, extra || {});
  }

  function summarize(route) {
    const dur = route.durationMillis || 0;
    const free = route.staticDurationMillis > 0 ? route.staticDurationMillis : dur;
    const ratio = free > 0 ? dur / free : 1;
    return { dur: dur, free: free, delay: Math.max(0, dur - free), ratio: ratio };
  }

  async function run(opts) {
    const withForecast = !opts || opts.withForecast !== false;
    const token = ++runToken;
    showError("");
    setBusy(true);

    try {
      await ensureMaps();

      const res = await RouteClass.computeRoutes(
        request(state.depart, MAIN_FIELDS, {
          computeAlternativeRoutes: true,
          extraComputations: ["TRAFFIC_ON_POLYLINE"]
        })
      );
      if (token !== runToken) return;
      const routes = (res && res.routes) || [];
      if (!routes.length) throw new Error("No driving route found between those places.");

      state.routes = routes;
      if (state.selected >= routes.length) state.selected = 0;

      renderSummary();
      renderRouteList();
      drawRoutes(true);

      if (withForecast) {
        $("#forecast-card").hidden = false;
        $("#forecast-summary").textContent = "Looking at the next few hours...";
        $("#forecast").textContent = "";
        const points = await buildForecast(routes[0]);
        if (token !== runToken) return;
        renderForecast(points);
      }
    } catch (err) {
      if (token !== runToken) return;
      showError(explain(err));
    } finally {
      if (token === runToken) setBusy(false);
    }
  }

  async function buildForecast(mainRoute) {
    const base = state.depart ? new Date(state.depart.getTime()) : new Date();
    const first = summarize(mainRoute);
    const points = [{ time: base, dur: first.dur, free: first.free, ratio: first.ratio, now: true }];

    const jobs = FORECAST_OFFSETS_MIN.map((off) => {
      const t = new Date(base.getTime() + off * 60000);
      return RouteClass.computeRoutes(request(t, ["durationMillis", "staticDurationMillis"]))
        .then((r) => ({ t: t, route: r.routes && r.routes[0] }));
    });
    const settled = await Promise.allSettled(jobs);
    settled.forEach((s) => {
      if (s.status === "fulfilled" && s.value.route) {
        const x = summarize(s.value.route);
        points.push({ time: s.value.t, dur: x.dur, free: x.free, ratio: x.ratio, now: false });
      }
    });
    return points;
  }

  // ---------- rendering ----------
  function renderSummary() {
    const route = state.routes[0];
    const s = summarize(route);
    const lvl = levelOf(s.ratio);
    const depart = state.depart || new Date();

    $("#results").hidden = false;

    const badge = $("#level-badge");
    badge.textContent = lvl.name;
    badge.className = "badge " + lvl.key;
    $("#level-note").textContent = lvl.note;

    const pct = Math.max(0, Math.round((s.ratio - 1) * 100));
    const fill = $("#meter-fill");
    fill.style.width = Math.min(100, (pct / 100) * 100) + "%";
    fill.style.background = "var(--" + lvl.key + ")";
    $("#delay-pct").textContent = pct < 3
      ? "Trip takes about the same as with no traffic."
      : "Trip takes " + pct + "% longer than with no traffic.";

    $("#stat-now").textContent = fmtDur(s.dur);
    $("#eta").textContent = (state.depart ? "Leaving " + fmtTime(depart) + ", " : "") +
      "arrive about " + fmtTime(new Date(depart.getTime() + s.dur));
    $("#stat-free").textContent = fmtDur(s.free);

    const d = $("#stat-delay");
    d.textContent = fmtDelay(s.delay);
    d.className = s.delay < 30000 ? "good" : "bad";
    $("#dist").textContent = route.distanceMeters ? fmtKm(route.distanceMeters) + " by the fastest route" : "";
  }

  function renderRouteList() {
    const card = $("#routes-card");
    const list = $("#route-list");
    list.textContent = "";
    card.hidden = state.routes.length < 2;

    state.routes.forEach((r, i) => {
      const s = summarize(r);
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", i === state.selected ? "true" : "false");
      b.innerHTML =
        '<span class="route-top"><span>' + esc(r.description || ("Route " + (i + 1))) + "</span><span>" + esc(fmtDur(s.dur)) + "</span></span>" +
        '<span class="route-sub">' + esc(r.distanceMeters ? fmtKm(r.distanceMeters) : "") +
        " &middot; " + esc(levelOf(s.ratio).name) +
        (s.delay >= 30000 ? " &middot; +" + esc(fmtDur(s.delay)) + " from traffic" : "") + "</span>";
      b.addEventListener("click", () => selectRoute(i));
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  function selectRoute(i) {
    state.selected = i;
    renderRouteList();
    drawRoutes(false);
  }

  function pathOf(r) {
    return (r.path || []).map((p) => ({ lat: p.lat, lng: p.lng }));
  }

  function clearOverlays() {
    overlays.forEach((o) => {
      if (typeof o.setMap === "function") o.setMap(null);
      else o.map = null;
    });
    overlays = [];
  }

  function drawRoutes(fit) {
    if (!map) return;
    clearOverlays();

    state.routes.forEach((r, i) => {
      if (i === state.selected) return;
      const line = new google.maps.Polyline({
        path: pathOf(r), strokeColor: "#8a94a6", strokeOpacity: 0.85, strokeWeight: 5, zIndex: 1, map: map
      });
      line.addListener("click", () => selectRoute(i));
      overlays.push(line);
    });

    const sel = state.routes[state.selected];
    let lines = [];
    try { lines = sel.createPolylines(); } catch (e) { lines = []; }
    if (!lines.length) {
      lines = [new google.maps.Polyline({ path: pathOf(sel), strokeColor: "#1a73e8", strokeWeight: 7 })];
    }
    lines.forEach((l) => {
      if (typeof l.setOptions === "function") l.setOptions({ zIndex: 5 });
      l.setMap(map);
      overlays.push(l);
    });

    try {
      sel.createWaypointAdvancedMarkers().forEach((m) => { m.map = map; overlays.push(m); });
    } catch (e) { /* markers are optional */ }

    if (fit && sel.viewport) map.fitBounds(sel.viewport);
  }

  function renderForecast(points) {
    const box = $("#forecast");
    box.textContent = "";
    if (!points.length) return;

    const maxDur = Math.max.apply(null, points.map((p) => p.dur));
    const best = points.reduce((a, b) => (b.dur < a.dur ? b : a));
    const now = points[0];

    points.forEach((p) => {
      const lvl = levelOf(p.ratio);
      const col = document.createElement("div");
      col.className = "fc" + (p === best && points.length > 1 && best.dur < now.dur * 0.97 ? " best" : "");
      col.setAttribute("role", "listitem");
      const h = Math.max(10, Math.round((p.dur / maxDur) * 100));
      col.innerHTML =
        '<span class="dur">' + esc(fmtDur(p.dur)) + "</span>" +
        '<div class="bar-wrap"><div class="bar ' + lvl.key + '" style="height:' + h + '%"></div></div>' +
        '<span class="t">' + esc(p.now && !state.depart ? "Now" : fmtTime(p.time)) + "</span>";
      box.appendChild(col);
    });

    const summary = $("#forecast-summary");
    if (now.ratio < 1.15) {
      summary.textContent = "No significant jam at departure. Leaving now is fine.";
      return;
    }
    const clear = points.find((p) => !p.now && p.time > now.time && p.ratio < 1.15);
    if (clear) {
      summary.textContent = "Traffic should ease around " + fmtTime(clear.time) +
        ". Drive time then drops to about " + fmtDur(clear.dur) +
        " (saves " + fmtDur(Math.max(0, now.dur - clear.dur)) + ").";
    } else if (best !== now) {
      summary.textContent = "The jam may last through the next 3 hours. Shortest drive in that window: leave around " +
        fmtTime(best.time) + " (" + fmtDur(best.dur) + ").";
    } else {
      summary.textContent = "Leaving now is the shortest option in the next 3 hours, even with traffic.";
    }
  }

  // ---------- form wiring ----------
  function readDepart() {
    if ($("#when").value !== "custom") return null;
    const v = $("#when-time").value;
    if (!v) throw new Error("Pick a date and time, or choose Leave: Now.");
    const d = new Date(v);
    if (isNaN(d.getTime())) throw new Error("That date and time is not valid.");
    if (d.getTime() < Date.now() - 60000) throw new Error("Choose a time that is now or later. Past times are not supported.");
    return d;
  }

  function syncUrl() {
    try {
      const q = new URLSearchParams({ from: state.origin, to: state.dest });
      history.replaceState(null, "", "?" + q.toString());
    } catch (e) { /* ignore */ }
  }

  function setupRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if ($("#auto").checked) {
      refreshTimer = setInterval(() => {
        if (state.routes.length && !document.hidden) run({ withForecast: false });
      }, REFRESH_MS);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    showError("");

    if (!apiKey) {
      $("#key-panel").hidden = false;
      $("#key-input").focus();
      showError("Add a Google Maps API key first.");
      return;
    }

    const from = $("#from").value.trim();
    const to = $("#to").value.trim();
    if (!from || !to) { showError("Enter both places."); return; }

    try {
      state.depart = readDepart();
    } catch (err) {
      showError(err.message);
      return;
    }
    state.origin = from;
    state.dest = to;
    state.selected = 0;
    syncUrl();
    setupRefresh();
    run({ withForecast: true });
  }

  function init() {
    if (!apiKey) $("#key-panel").hidden = false;

    $("#key-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("#key-input").value.trim();
      if (!v) return;
      storeSet(KEY_STORE, v);
      location.reload();
    });

    $("#search").addEventListener("submit", onSubmit);

    $("#swap").addEventListener("click", () => {
      const a = $("#from").value;
      $("#from").value = $("#to").value;
      $("#to").value = a;
    });

    $("#locate").addEventListener("click", () => {
      if (!navigator.geolocation) { showError("Your browser does not support location."); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          $("#from").value = pos.coords.latitude.toFixed(5) + ", " + pos.coords.longitude.toFixed(5);
        },
        () => showError("Could not get your location. Type the starting place instead."),
        { enableHighAccuracy: false, timeout: 10000 }
      );
    });

    $("#when").addEventListener("change", () => {
      const custom = $("#when").value === "custom";
      $("#when-wrap").hidden = !custom;
      if (custom && !$("#when-time").value) {
        const d = new Date(Date.now() + 30 * 60000);
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        $("#when-time").value = d.toISOString().slice(0, 16);
      }
    });

    $("#auto").addEventListener("change", setupRefresh);

    $("#layer-toggle").addEventListener("change", () => {
      if (trafficLayer) trafficLayer.setMap($("#layer-toggle").checked ? map : null);
    });

    // Shareable links: ?from=...&to=...
    const q = new URLSearchParams(location.search);
    if (q.get("from")) $("#from").value = q.get("from");
    if (q.get("to")) $("#to").value = q.get("to");
    if (q.get("from") && q.get("to") && apiKey) {
      $("#search").requestSubmit();
    }
  }

  init();
})();
