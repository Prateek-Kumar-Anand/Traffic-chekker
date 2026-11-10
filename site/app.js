"use strict";

(function () {
  // ---------------------------------------------------------------------------
  // Safety rules for this file:
  //  - No secrets live here. Google Maps is only ever called by the backend, and the backend
  //    only answers requests that carry a valid Firebase login token.
  //  - Nothing is written with innerHTML. All text goes in through textContent,
  //    so place names, route descriptions and stored data can never become markup.
  //  - Everything read back from the server or from localStorage is re-validated.
  // ---------------------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);

  const API_BASE = String((window.APP_CONFIG && window.APP_CONFIG.API_BASE) || "").replace(/\/+$/, "");
  // An unbuilt page still has the "__..." placeholder, which is never a valid backend address.
  const CONFIGURED = /^https?:\/\//.test(API_BASE) && API_BASE.indexOf("__") === -1;

  const STORE_PREFIX = "trafficChecker.v3.";
  const MAX_RECENT = 8;
  const MAX_SAVED = 20;
  const REFRESH_MS = 5 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 25000;
  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---------- small DOM helper (refuses to create event-handler or style attributes) ----------
  function el(tag, props, kids) {
    const n = document.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((k) => {
      if (k === "text") n.textContent = p[k];
      else if (k === "class") n.className = p[k];
      else if (k === "style" || /^on/i.test(k)) throw new Error("blocked attribute: " + k);
      else n.setAttribute(k, p[k]);
    });
    (kids || []).forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  }

  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
    return n;
  }

  // ---------- formatting ----------
  function fmtDur(sec) {
    const mins = Math.round(sec / 60);
    if (mins < 1) return "< 1 min";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (!h) return m + " min";
    return m ? h + " hr " + m + " min" : h + " hr";
  }
  const fmtDelay = (sec) => (sec < 30 ? "No delay" : fmtDur(sec));
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0) + " km";

  // Traffic level from ratio = (time with traffic) / (time with no traffic)
  function levelOf(ratio) {
    if (ratio < 1.1) return { key: "ok", name: "Clear", note: "Roads are flowing normally." };
    if (ratio < 1.25) return { key: "light", name: "Light traffic", note: "Minor slowdowns on the way." };
    if (ratio < 1.5) return { key: "mid", name: "Moderate traffic", note: "Noticeable slowdowns. Allow extra time." };
    if (ratio < 2) return { key: "heavy", name: "Heavy traffic", note: "Significant jam on this route." };
    return { key: "severe", name: "Severe jam", note: "Very slow. The trip takes more than twice as long as normal." };
  }

  // ---------- validation of anything we did not create ----------
  function cleanPlace(v) {
    if (typeof v !== "string") return "";
    return v.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  }

  function cleanPair(p) {
    if (!p || typeof p !== "object") return null;
    const from = cleanPlace(p.from);
    const to = cleanPlace(p.to);
    return from.length >= 2 && to.length >= 2 ? { from: from, to: to } : null;
  }

  const pairKey = (p) => (p.from + "|" + p.to).toLowerCase();

  function dedupe(list) {
    const seen = new Set();
    return list.filter((p) => {
      const k = pairKey(p);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function num(v, min, max) {
    return typeof v === "number" && isFinite(v) && v >= min && v <= max ? v : null;
  }

  function cleanRoute(r) {
    if (!r || typeof r !== "object") return null;
    const dur = num(r.durationSec, 0, 864000);
    const free = num(r.freeSec, 0, 864000);
    if (dur === null || free === null) return null;
    const poly = typeof r.polyline === "string" && r.polyline.length <= 100000 && /^[\x3f-\x7e]*$/.test(r.polyline) ? r.polyline : "";
    const speeds = Array.isArray(r.speeds)
      ? r.speeds.slice(0, 5000).filter((s) => Array.isArray(s) && s.length === 3 &&
          Number.isInteger(s[0]) && Number.isInteger(s[1]) && s[0] >= 0 && s[1] > s[0] &&
          (s[2] === 0 || s[2] === 1 || s[2] === 2))
      : [];
    return {
      durationSec: dur,
      freeSec: free > 0 ? free : dur,
      distanceM: num(r.distanceM, 0, 1e7) || 0,
      description: typeof r.description === "string" ? cleanPlace(r.description).slice(0, 80) : "",
      polyline: poly,
      speeds: speeds,
    };
  }

  function cleanResponse(d) {
    if (!d || typeof d !== "object" || !Array.isArray(d.routes)) throw new Error("bad response");
    const routes = d.routes.slice(0, 4).map(cleanRoute).filter(Boolean);
    if (!routes.length) throw new Error("bad response");
    let forecast = null;
    if (Array.isArray(d.forecast)) {
      forecast = d.forecast.slice(0, 12).map((p) => {
        if (!p || typeof p !== "object") return null;
        const off = num(p.offsetMin, 1, 600);
        const dur = num(p.durationSec, 0, 864000);
        const free = num(p.freeSec, 0, 864000);
        return off === null || dur === null || free === null ? null : { offsetMin: off, durationSec: dur, freeSec: free > 0 ? free : dur };
      }).filter(Boolean);
    }
    return { routes: routes, forecast: forecast };
  }

  // ---------- data kept in this browser (localStorage) ----------
  function emptyData() { return { recent: [], saved: [], auto: false }; }

  // Saved data is kept per account, so two people sharing one browser do not see each other's routes.
  let storeKey = null;

  function loadData(key) {
    const out = emptyData();
    if (!key) return out;
    let raw = null;
    try { raw = window.localStorage.getItem(key); } catch (e) { return out; }
    if (!raw || raw.length > 100000) return out;
    let j;
    try { j = JSON.parse(raw); } catch (e) { return out; }
    if (!j || typeof j !== "object") return out;
    out.recent = dedupe((Array.isArray(j.recent) ? j.recent : []).map(cleanPair).filter(Boolean)).slice(0, MAX_RECENT);
    out.saved = dedupe((Array.isArray(j.saved) ? j.saved : []).map(cleanPair).filter(Boolean)).slice(0, MAX_SAVED);
    out.auto = j.auto === true;
    return out;
  }

  let data = emptyData();

  function persist() {
    if (!storeKey) return;
    try { window.localStorage.setItem(storeKey, JSON.stringify(data)); }
    catch (e) { /* private mode or storage full: the page keeps working from memory */ }
  }

  // ---------- state ----------
  const state = { routes: [], forecast: null, selected: 0, from: "", to: "", depart: null, loaded: false };
  const Auth = window.TCAuth || { status: "failed" };
  let refreshTimer = null;
  let runToken = 0;

  // ---------- UI helpers ----------
  function showError(msg) {
    const e = $("#error");
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  function setBusy(busy) {
    const b = $("#go");
    b.disabled = busy || !CONFIGURED;
    b.textContent = busy ? "Checking..." : "Check traffic";
  }

  // ---------- backend call ----------
  function ApiError(status, code, message, retryAfter) {
    this.status = status;
    this.code = code;
    this.serverMessage = message;
    this.retryAfter = retryAfter;
  }

  async function callApi(payload) {
    try {
      return await callApiOnce(payload, false);
    } catch (err) {
      // An expired login token is refreshed once before giving up.
      if (err instanceof ApiError && err.status === 401) return callApiOnce(payload, true);
      throw err;
    }
  }

  async function callApiOnce(payload, freshToken) {
    const token = await Auth.getToken(freshToken);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(API_BASE + "/api/route", {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (!res.ok) {
        throw new ApiError(
          res.status,
          body && typeof body.error === "string" ? body.error.slice(0, 40) : "",
          body && typeof body.message === "string" ? cleanPlace(body.message).slice(0, 200) : "",
          parseInt(res.headers.get("Retry-After") || "", 10) || 0
        );
      }
      return cleanResponse(body);
    } finally {
      clearTimeout(timer);
    }
  }

  function friendlyError(err) {
    if (err && err.name === "AbortError") return "The request took too long. Please try again.";
    if (err instanceof ApiError) {
      switch (err.code) {
        case "rate_limited":
          return "You are checking too quickly. Please wait " + (err.retryAfter || 60) + " seconds and try again.";
        case "quota_exceeded":
        case "no_route":
        case "invalid_request":
          return err.serverMessage || "That request could not be completed.";
        case "unauthorized":
          return "Your session has ended. Please sign in again.";
        case "email_not_verified":
          return "Confirm your email address first, then try again.";
        case "forbidden_origin":
          return "This website is not allowed to use the traffic service. The site owner must add this address to the backend's ALLOWED_ORIGINS setting.";
        default:
          return "The traffic service is having trouble right now. Please try again shortly.";
      }
    }
    if (err && err.code === "auth/no-current-user") return "Your session has ended. Please sign in again.";
    if (err && typeof err.code === "string" && err.code.indexOf("auth/") === 0) return "Could not refresh your sign-in. Check your connection and try again.";
    if (err && err.message === "bad response") return "The traffic service sent an unexpected reply. Please try again.";
    return "Could not reach the traffic service. Check your connection and try again.";
  }

  // ---------- run a check ----------
  async function run(withForecast) {
    const token = ++runToken;
    showError("");
    setBusy(true);
    try {
      const payload = { from: state.from, to: state.to, forecast: withForecast };
      if (state.depart) payload.depart = state.depart.toISOString();
      const res = await callApi(payload);
      if (token !== runToken) return;

      state.routes = res.routes;
      if (state.selected >= res.routes.length) state.selected = 0;
      state.loaded = true;
      if (withForecast) state.forecast = res.forecast;

      renderSummary();
      renderRouteList();
      drawMap();
      renderForecast();
      if (withForecast) rememberRecent();
      refreshMine();
    } catch (err) {
      if (token !== runToken) return;
      // A login that no longer works sends the person back to the sign-in page.
      if ((err instanceof ApiError && err.status === 401) || (err && err.code === "auth/no-current-user")) {
        signOutWithMessage("Your session has ended. Please sign in again.");
        return;
      }
      showError(friendlyError(err));
      // Stop auto-refresh when the service pushes back, so we never hammer it.
      if (err instanceof ApiError && (err.status === 429 || err.status === 503 || err.status === 403)) stopAuto();
    } finally {
      if (token === runToken) setBusy(false);
    }
  }

  // ---------- rendering ----------
  function renderSummary() {
    const r = state.routes[0];
    const dur = r.durationSec;
    const free = r.freeSec;
    const ratio = free > 0 ? dur / free : 1;
    const lvl = levelOf(ratio);
    const depart = state.depart || new Date();
    const delay = Math.max(0, dur - free);

    $("#results").hidden = false;

    const badge = $("#level-badge");
    badge.textContent = lvl.name;
    badge.className = "badge " + lvl.key;
    $("#level-note").textContent = lvl.note;

    const pct = Math.max(0, Math.round((ratio - 1) * 100));
    const fill = $("#meter-fill");
    fill.style.width = Math.min(100, pct) + "%";
    fill.className = lvl.key;
    $("#delay-pct").textContent = pct < 3
      ? "Trip takes about the same as with no traffic."
      : "Trip takes " + pct + "% longer than with no traffic.";

    $("#stat-now").textContent = fmtDur(dur);
    $("#eta").textContent = (state.depart ? "Leaving " + fmtTime(depart) + ", " : "") +
      "arrive about " + fmtTime(new Date(depart.getTime() + dur * 1000));
    $("#stat-free").textContent = fmtDur(free);

    const d = $("#stat-delay");
    d.textContent = fmtDelay(delay);
    d.className = delay < 30 ? "good" : "bad";
    $("#dist").textContent = r.distanceM ? fmtKm(r.distanceM) + " by the fastest route" : "";

    // Fixed https prefix + encoded values: the link can only ever open Google Maps.
    const link = $("#open-gmaps");
    link.href = "https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=" +
      encodeURIComponent(state.from) + "&destination=" + encodeURIComponent(state.to);
    link.hidden = false;
  }

  function renderRouteList() {
    const card = $("#routes-card");
    const list = $("#route-list");
    list.textContent = "";
    card.hidden = state.routes.length < 2;

    state.routes.forEach((r, i) => {
      const ratio = r.freeSec > 0 ? r.durationSec / r.freeSec : 1;
      const delay = Math.max(0, r.durationSec - r.freeSec);
      const sub = [r.distanceM ? fmtKm(r.distanceM) : "", levelOf(ratio).name];
      if (delay >= 30) sub.push("+" + fmtDur(delay) + " from traffic");

      const b = el("button", { type: "button", "aria-pressed": i === state.selected ? "true" : "false" }, [
        el("span", { class: "route-top" }, [
          el("span", { text: r.description || "Route " + (i + 1) }),
          el("span", { text: fmtDur(r.durationSec) }),
        ]),
        el("span", { class: "route-sub", text: sub.filter(Boolean).join(" · ") }),
      ]);
      b.addEventListener("click", () => {
        state.selected = i;
        renderRouteList();
        drawMap();
      });
      list.appendChild(el("li", null, [b]));
    });
  }

  // Google's encoded polyline format, 1e-5 degree precision.
  function decodePolyline(str) {
    const pts = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length && pts.length < 50000) {
      let b, shift = 0, result = 0;
      do {
        if (i >= str.length) return pts;
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do {
        if (i >= str.length) return pts;
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      pts.push([lat / 1e5, lng / 1e5]);
    }
    return pts;
  }

  function drawMap() {
    const box = $("#map");
    box.textContent = "";

    const sets = state.routes.map((r) => decodePolyline(r.polyline));
    const sel = sets[state.selected] || [];
    if (sel.length < 2) {
      box.appendChild(el("p", { class: "map-empty", text: "A route drawing is not available for this trip." }));
      return;
    }

    const W = 640, H = 380, PAD = 40;
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    sets.forEach((s) => s.forEach((p) => {
      if (p[0] < minLat) minLat = p[0];
      if (p[0] > maxLat) maxLat = p[0];
      if (p[1] < minLng) minLng = p[1];
      if (p[1] > maxLng) maxLng = p[1];
    }));
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const spanX = Math.max((maxLng - minLng) * kx, 1e-6);
    const spanY = Math.max(maxLat - minLat, 1e-6);
    const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
    const offX = (W - spanX * scale) / 2;
    const offY = (H - spanY * scale) / 2;
    const proj = (p) => [offX + (p[1] - minLng) * kx * scale, offY + (maxLat - p[0]) * scale];
    const toPoints = (pts) => pts.map((p) => { const q = proj(p); return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ");

    const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
    svg.setAttribute("aria-label", "Route from " + state.from + " to " + state.to + ", coloured by traffic");
    svg.appendChild(svgEl("rect", { class: "map-bg", x: 0, y: 0, width: W, height: H }));

    sets.forEach((pts, i) => {
      if (i !== state.selected && pts.length > 1) svg.appendChild(svgEl("polyline", { class: "route-line alt", points: toPoints(pts) }));
    });

    const route = state.routes[state.selected];
    const ratio = route.freeSec > 0 ? route.durationSec / route.freeSec : 1;
    // Base line first (green when there is per-section data, otherwise the overall level),
    // then slow and jammed sections painted on top.
    const baseClass = route.speeds.length ? "k0" : ratio < 1.25 ? "k0" : ratio < 1.5 ? "k1" : "k2";
    svg.appendChild(svgEl("polyline", { class: "route-line " + baseClass, points: toPoints(sel) }));
    route.speeds.forEach((s) => {
      if (s[2] === 0 || s[0] >= sel.length - 1) return;
      const part = sel.slice(s[0], Math.min(s[1], sel.length - 1) + 1);
      if (part.length > 1) svg.appendChild(svgEl("polyline", { class: "route-line k" + s[2], points: toPoints(part) }));
    });

    [["A", sel[0]], ["B", sel[sel.length - 1]]].forEach((pin) => {
      const q = proj(pin[1]);
      const g = svgEl("g");
      g.appendChild(svgEl("circle", { class: "pin", cx: q[0].toFixed(1), cy: q[1].toFixed(1), r: 14 }));
      const t = svgEl("text", { class: "pin-label", x: q[0].toFixed(1), y: q[1].toFixed(1) });
      t.textContent = pin[0];
      g.appendChild(t);
      svg.appendChild(g);
    });

    box.appendChild(svg);
  }

  function renderForecast() {
    const card = $("#forecast-card");
    const box = $("#forecast");
    box.textContent = "";
    if (!state.forecast || !state.forecast.length || !state.routes.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const base = state.depart ? state.depart.getTime() : Date.now();
    const now = state.routes[0];
    const points = [{ time: new Date(base), dur: now.durationSec, free: now.freeSec, now: true }]
      .concat(state.forecast.map((p) => ({ time: new Date(base + p.offsetMin * 60000), dur: p.durationSec, free: p.freeSec, now: false })));
    points.forEach((p) => { p.ratio = p.free > 0 ? p.dur / p.free : 1; });

    const maxDur = Math.max.apply(null, points.map((p) => p.dur)) || 1;
    const best = points.reduce((a, b) => (b.dur < a.dur ? b : a));

    points.forEach((p) => {
      const lvl = levelOf(p.ratio);
      const isBest = p === best && best.dur < points[0].dur * 0.97;
      const bar = el("div", { class: "bar " + lvl.key });
      bar.style.height = Math.max(10, Math.round((p.dur / maxDur) * 100)) + "%";
      box.appendChild(el("div", { class: "fc" + (isBest ? " best" : ""), role: "listitem" }, [
        el("span", { class: "dur", text: fmtDur(p.dur) }),
        el("div", { class: "bar-wrap" }, [bar]),
        el("span", { class: "t", text: p.now && !state.depart ? "Now" : fmtTime(p.time) }),
      ]));
    });

    const first = points[0];
    const summary = $("#forecast-summary");
    if (first.ratio < 1.15) {
      summary.textContent = "No significant jam at departure. Leaving now is fine.";
      return;
    }
    const clear = points.find((p) => !p.now && p.ratio < 1.15);
    if (clear) {
      summary.textContent = "Traffic should ease around " + fmtTime(clear.time) +
        ". Drive time then drops to about " + fmtDur(clear.dur) +
        " (saves " + fmtDur(Math.max(0, first.dur - clear.dur)) + ").";
    } else if (best !== first) {
      summary.textContent = "The jam may last through the next 3 hours. Shortest drive in that window: leave around " +
        fmtTime(best.time) + " (" + fmtDur(best.dur) + ").";
    } else {
      summary.textContent = "Leaving now is the shortest option in the next 3 hours, even with traffic.";
    }
  }

  // ---------- recent and saved routes (this browser only) ----------
  function rememberRecent() {
    data.recent = dedupe([{ from: state.from, to: state.to }].concat(data.recent)).slice(0, MAX_RECENT);
    persist();
  }

  function isSaved() {
    const k = pairKey({ from: state.from, to: state.to });
    return data.saved.some((p) => pairKey(p) === k);
  }

  function renderChips(listEl, pairs, removable) {
    listEl.textContent = "";
    if (!pairs.length) {
      listEl.appendChild(el("li", { class: "empty", text: removable ? "No saved routes yet." : "No recent routes yet." }));
      return;
    }
    pairs.forEach((p) => {
      const open = el("button", { type: "button", title: p.from + " to " + p.to, text: p.from + " → " + p.to });
      open.addEventListener("click", () => {
        $("#from").value = p.from;
        $("#to").value = p.to;
        $("#search").requestSubmit();
      });
      const kids = [open];
      if (removable) {
        const x = el("button", { type: "button", class: "x", "aria-label": "Remove saved route " + p.from + " to " + p.to, text: "×" });
        x.addEventListener("click", () => {
          data.saved = data.saved.filter((s) => pairKey(s) !== pairKey(p));
          persist();
          refreshMine();
        });
        kids.push(x);
      }
      listEl.appendChild(el("li", { class: "chip" }, kids));
    });
  }

  function refreshMine() {
    renderChips($("#saved-list"), data.saved, true);
    renderChips($("#recent-list"), data.recent, false);

    const dl = $("#places");
    dl.textContent = "";
    const seen = new Set();
    data.saved.concat(data.recent).forEach((p) => {
      [p.from, p.to].forEach((v) => {
        if (!seen.has(v.toLowerCase()) && seen.size < 40) {
          seen.add(v.toLowerCase());
          const o = document.createElement("option");
          o.value = v;
          dl.appendChild(o);
        }
      });
    });

    const btn = $("#save-route");
    btn.disabled = !state.loaded;
    btn.textContent = state.loaded && isSaved() ? "Remove from saved" : "Save this route";
  }

  // ---------- auto-refresh ----------
  function clearTimer() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  function stopAuto() {
    clearTimer();
    $("#auto").checked = false;
    data.auto = false;
    persist();
  }

  function applyAuto() {
    clearTimer();
    if ($("#auto").checked) {
      refreshTimer = setInterval(() => {
        if (state.loaded && !document.hidden && !$("#go").disabled) run(false);
      }, REFRESH_MS);
    }
  }

  // ---------- form ----------
  function readDepart() {
    if ($("#when").value !== "custom") return null;
    const v = $("#when-time").value;
    if (!v) throw new Error("Pick a date and time, or choose Leave: Now.");
    const d = new Date(v);
    if (isNaN(d.getTime())) throw new Error("That date and time is not valid.");
    if (d.getTime() > Date.now() + 7 * 24 * 3600 * 1000) throw new Error("Choose a time within the next 7 days.");
    return d.getTime() < Date.now() + 60000 ? null : d;
  }

  function onSubmit(e) {
    e.preventDefault();
    showError("");
    if (!CONFIGURED) { showError("This site is not connected to its backend yet."); return; }
    if (!userInfo) return;

    const from = cleanPlace($("#from").value);
    const to = cleanPlace($("#to").value);
    if (from.length < 2 || to.length < 2) { showError("Enter both places (at least 2 characters each)."); return; }

    try { state.depart = readDepart(); } catch (err) { showError(err.message); return; }
    state.from = from;
    state.to = to;
    state.selected = 0;
    state.forecast = null;
    state.loaded = false;
    applyAuto();
    run(true);
  }

  // ---------- views: sign in, confirm email, app ----------
  let userInfo = null;
  const VIEWS = ["boot", "login-view", "verify-view", "app-view"];

  function showView(id) {
    VIEWS.forEach((v) => { $("#" + v).hidden = v !== id; });
    window.scrollTo(0, 0);
  }

  function setText(sel, msg) {
    const n = $(sel);
    n.textContent = msg || "";
    n.hidden = !msg;
  }

  function authMessage(err) {
    switch (err && err.code) {
      case "auth/invalid-credential":
      case "auth/invalid-login-credentials":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return "Email or password is incorrect.";
      case "auth/invalid-email": return "Enter a valid email address.";
      case "auth/missing-password": return "Enter your password.";
      case "auth/email-already-in-use": return "An account with this email already exists. Sign in instead.";
      case "auth/weak-password": return "Choose a password with at least 8 characters.";
      case "auth/too-many-requests": return "Too many attempts. Wait a few minutes and try again.";
      case "auth/network-request-failed": return "Can't reach the sign-in service. Check your connection and try again.";
      case "auth/popup-blocked": return "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.";
      case "auth/popup-closed-by-user":
      case "auth/cancelled-popup-request": return "";
      case "auth/unauthorized-domain": return "This website's address is not authorised for sign-in. The site owner must add it in Firebase under Authentication > Settings > Authorized domains.";
      case "auth/operation-not-allowed": return "This sign-in method is turned off. The site owner must enable it in Firebase under Authentication > Sign-in method.";
      case "auth/user-disabled": return "This account has been disabled.";
      default: return "Could not sign you in. Please try again.";
    }
  }

  // Login page --------------------------------------------------------------
  let mode = "signin";

  function setMode(m) {
    mode = m;
    const up = m === "signup";
    $("#login-title").textContent = up ? "Create your account" : "Sign in";
    $("#login-sub").textContent = up ? "We will email you a link to confirm your address." : "Use your Google account or your email.";
    $("#email-submit").textContent = up ? "Create account" : "Sign in";
    $("#toggle-mode").textContent = up ? "I already have an account" : "Create an account";
    $("#password").autocomplete = up ? "new-password" : "current-password";
    $("#forgot").hidden = up;
    setText("#login-error", "");
    setText("#login-msg", "");
  }

  function setLoginBusy(busy) {
    ["#google-btn", "#email-submit", "#toggle-mode", "#forgot"].forEach((sel) => { $(sel).disabled = busy; });
  }

  async function guarded(fn) {
    setText("#login-error", "");
    setText("#login-msg", "");
    setLoginBusy(true);
    try { await fn(); }
    catch (err) { setText("#login-error", authMessage(err)); }
    finally { setLoginBusy(false); }
  }

  function validEmail(v) { return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  function initLogin() {
    $("#google-btn").addEventListener("click", () => guarded(() => Auth.signInWithGoogle()));

    $("#email-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const email = $("#email").value.trim();
      const pw = $("#password").value;
      if (!validEmail(email)) { setText("#login-error", "Enter a valid email address."); return; }
      if (!pw) { setText("#login-error", "Enter your password."); return; }
      if (mode === "signup" && pw.length < 8) { setText("#login-error", "Choose a password with at least 8 characters."); return; }
      guarded(async () => {
        if (mode === "signup") await Auth.signUp(email, pw);
        else await Auth.signIn(email, pw);
        $("#password").value = "";
      });
    });

    $("#toggle-mode").addEventListener("click", () => setMode(mode === "signup" ? "signin" : "signup"));

    $("#forgot").addEventListener("click", () => {
      const email = $("#email").value.trim();
      if (!validEmail(email)) { setText("#login-error", "Enter your email address above, then select this again."); return; }
      guarded(async () => {
        try { await Auth.resetPassword(email); }
        catch (err) {
          // Do not reveal whether an account exists for this address.
          if (err && err.code !== "auth/user-not-found") throw err;
        }
        setText("#login-msg", "If an account exists for that address, we have sent a link to reset the password.");
      });
    });
  }

  // Confirm-email page -------------------------------------------------------
  function initVerify() {
    $("#verify-continue").addEventListener("click", async () => {
      setText("#verify-error", ""); setText("#verify-msg", "");
      try {
        const u = await Auth.refreshUser();
        if (u && u.verified) { onUser(u); return; }
        setText("#verify-error", "Not confirmed yet. Open the link in the email we sent, then try again.");
      } catch (err) { setText("#verify-error", authMessage(err)); }
    });

    $("#verify-resend").addEventListener("click", async () => {
      setText("#verify-error", ""); setText("#verify-msg", "");
      try {
        await Auth.resendVerification();
        setText("#verify-msg", "Email sent. It can take a minute to arrive; check your spam folder too.");
      } catch (err) { setText("#verify-error", authMessage(err)); }
    });

    $("#verify-signout").addEventListener("click", () => { Auth.signOut(); });
  }

  // Who is signed in -----------------------------------------------------------
  let pendingLoginMsg = "";

  function signOutWithMessage(msg) {
    pendingLoginMsg = msg; // shown by onUser(null) once the sign-out has taken effect
    Promise.resolve(Auth.signOut()).catch(() => {});
  }

  function resetAppState() {
    runToken++;               // ignore any request still in flight
    clearTimer();
    state.routes = []; state.forecast = null; state.selected = 0; state.from = ""; state.to = ""; state.depart = null; state.loaded = false;
    $("#results").hidden = true;
    $("#routes-card").hidden = true;
    $("#forecast-card").hidden = true;
    $("#from").value = "";
    $("#to").value = "";
    $("#when").value = "now";
    $("#when-wrap").hidden = true;
    showError("");
    setBusy(false);
    data = emptyData();
    storeKey = null;
  }

  function enterApp(u) {
    resetAppState();
    storeKey = STORE_PREFIX + String(u.uid).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
    data = loadData(storeKey);
    $("#account-email").textContent = u.email;
    $("#auto").checked = data.auto;
    if (!CONFIGURED) {
      showError("This site is not connected to its backend yet (the API address is missing). If you own this site, see the README.");
      $("#go").disabled = true;
    }
    applyAuto();
    refreshMine();
    showView("app-view");
  }

  function onUser(u) {
    userInfo = u;
    if (!u) {
      resetAppState();
      setMode("signin");
      setText("#login-msg", pendingLoginMsg);
      pendingLoginMsg = "";
      $("#password").value = "";
      showView("login-view");
      return;
    }
    if (!u.verified) {
      resetAppState();
      $("#verify-email").textContent = u.email;
      setText("#verify-msg", ""); setText("#verify-error", "");
      showView("verify-view");
      return;
    }
    setText("#login-msg", "");
    enterApp(u);
  }

  // The app itself --------------------------------------------------------------
  function initApp() {
    $("#search").addEventListener("submit", onSubmit);

    $("#sign-out").addEventListener("click", () => { Auth.signOut(); });

    $("#swap").addEventListener("click", () => {
      const a = $("#from").value;
      $("#from").value = $("#to").value;
      $("#to").value = a;
    });

    $("#locate").addEventListener("click", () => {
      if (!navigator.geolocation) { showError("Your browser does not support location."); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => { $("#from").value = pos.coords.latitude.toFixed(5) + ", " + pos.coords.longitude.toFixed(5); },
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

    $("#auto").addEventListener("change", () => {
      data.auto = $("#auto").checked;
      persist();
      applyAuto();
    });

    $("#save-route").addEventListener("click", () => {
      if (!state.loaded) return;
      const k = pairKey({ from: state.from, to: state.to });
      if (isSaved()) {
        data.saved = data.saved.filter((p) => pairKey(p) !== k);
      } else {
        data.saved = dedupe([{ from: state.from, to: state.to }].concat(data.saved)).slice(0, MAX_SAVED);
      }
      persist();
      refreshMine();
    });

    $("#clear-data").addEventListener("click", () => {
      if (!window.confirm("Delete all saved and recent routes from this browser?")) return;
      data = emptyData();
      stopAuto(); // writes the (now empty) record, so remove the key afterwards
      try { if (storeKey) window.localStorage.removeItem(storeKey); } catch (e) { /* ignore */ }
      refreshMine();
    });
  }

  function init() {
    initLogin();
    initVerify();
    initApp();

    if (Auth.status !== "ready") {
      // Firebase is not set up, or its script could not load: say so instead of showing a dead page.
      const off = Auth.status === "unconfigured"
        ? "Sign-in is not set up yet. If you own this site, add your Firebase settings (see the README)."
        : "The sign-in service could not load. Check your connection and reload the page.";
      ["#google-btn", "#email-submit", "#toggle-mode", "#forgot"].forEach((sel) => { $(sel).disabled = true; });
      setText("#login-error", off);
      showView("login-view");
      return;
    }
    Auth.onChange(onUser);
  }

  // Firebase loads asynchronously; wait until it is ready (or known to have failed).
  Promise.resolve(window.TCAuthReady).then(init);
})();
