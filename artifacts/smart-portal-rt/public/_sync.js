/* Replit DB sync layer for Smart Portal RT.
   Real-time multi-device sync:
   - Boot: synchronous XHR loads server state into localStorage before app init.
   - Wraps localStorage.setItem/removeItem/clear → debounced PUT batch to server.
   - SSE stream (/api/kv/stream) pushes other clients' writes instantly.
   - Polling (/api/kv?since=...) is a resilience fallback (slower interval).
   - Visibility/focus change → immediate poll to catch missed updates.
   - Echo guard compares value + timestamp so own writes don't double-apply.
*/
(function () {
  if (window.__GT_SYNC_INSTALLED__) return;
  window.__GT_SYNC_INSTALLED__ = true;

  var API_BASE = "/api/kv";
  var SSE_URL = "/api/kv/stream";
  var POLL_MS = 8000;          // fallback polling (SSE handles real-time)
  var POLL_MS_NO_SSE = 2500;   // faster polling when SSE is down
  var DEBOUNCE_MS = 250;       // outbound write debounce
  var ECHO_GUARD_MS = 2500;    // skip echoes of our own writes (matched by value)

  // Unique id per browser tab — server attaches this to broadcasts.
  var ORIGIN_ID =
    "o-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  window.__GT_SYNC_ORIGIN_ID__ = ORIGIN_ID;

  // Keys that are purely local/UI state — not synced across devices.
  var LOCAL_ONLY = {
    isLoggedIn: 1,
    loggedInAs: 1,
    loggedInWarga: 1,
    gt_theme: 1,
    gt_notif_read: 1,
  };

  function isLocalOnly(key) {
    if (!key) return true;
    if (LOCAL_ONLY[key]) return true;
    if (key.indexOf("gt_local_") === 0) return true;
    return false;
  }

  var ls = window.localStorage;
  var origSet = ls.setItem.bind(ls);
  var origRemove = ls.removeItem.bind(ls);
  var origClear = ls.clear.bind(ls);
  var origGet = ls.getItem.bind(ls);

  // ---- Boot phase: synchronous load from server -------------------------
  var serverTime = null;
  function showOverlay(msg) {
    try {
      var el = document.createElement("div");
      el.id = "__gt_sync_overlay__";
      el.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;background:rgba(255,255,255,0.92);display:flex;align-items:center;justify-content:center;font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#334;";
      el.innerHTML =
        '<div style="text-align:center"><div style="width:42px;height:42px;border:4px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:gtspin 0.9s linear infinite;margin:0 auto 12px"></div><div>' +
        (msg || "Memuat data dari server…") +
        '</div></div><style>@keyframes gtspin{to{transform:rotate(360deg)}}</style>';
      (document.body || document.documentElement).appendChild(el);
    } catch (e) {}
  }
  function hideOverlay() {
    var el = document.getElementById("__gt_sync_overlay__");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (!window.__GT_SYNC_BOOTED__) showOverlay();
    });
  } else {
    showOverlay();
  }

  function bootLoad() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", API_BASE, false); // synchronous boot load
      xhr.setRequestHeader("Accept", "application/json");
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        var data = JSON.parse(xhr.responseText);
        serverTime = data.serverTime || new Date().toISOString();
        var entries = data.entries || [];
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (isLocalOnly(e.key)) continue;
          if (e.value == null) origRemove(e.key);
          else origSet(e.key, e.value);
        }
      } else {
        console.warn("[gt-sync] boot load failed:", xhr.status);
      }
    } catch (err) {
      console.warn("[gt-sync] boot load error:", err);
    } finally {
      window.__GT_SYNC_BOOTED__ = true;
      hideOverlay();
    }
  }
  bootLoad();

  // ---- Write queue ------------------------------------------------------
  var pendingWrites = Object.create(null); // key -> value (string | null for delete)
  // Track last value+ts we wrote — used to recognise echoes precisely.
  var lastLocalWrite = Object.create(null); // key -> { value, ts }
  var flushTimer = null;
  var flushing = false;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function flush() {
    flushTimer = null;
    if (flushing) {
      scheduleFlush();
      return;
    }
    var keys = Object.keys(pendingWrites);
    if (keys.length === 0) return;
    var writes = [];
    var deletes = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = pendingWrites[k];
      if (v === null) deletes.push(k);
      else writes.push({ key: k, value: v });
    }
    pendingWrites = Object.create(null);
    flushing = true;
    fetch(API_BASE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        writes: writes,
        deletes: deletes,
        originId: ORIGIN_ID,
      }),
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (resp) {
        if (resp && resp.serverTime) serverTime = resp.serverTime;
      })
      .catch(function (err) {
        console.warn("[gt-sync] flush failed, re-queueing:", err);
        for (var i = 0; i < writes.length; i++) {
          if (!(writes[i].key in pendingWrites))
            pendingWrites[writes[i].key] = writes[i].value;
        }
        for (var j = 0; j < deletes.length; j++) {
          if (!(deletes[j] in pendingWrites)) pendingWrites[deletes[j]] = null;
        }
        scheduleFlush();
      })
      .finally(function () {
        flushing = false;
        if (Object.keys(pendingWrites).length > 0) scheduleFlush();
      });
  }

  function queueWrite(key, value) {
    pendingWrites[key] = value;
    lastLocalWrite[key] = { value: value, ts: Date.now() };
    scheduleFlush();
  }

  // ---- Wrap localStorage --------------------------------------------------
  ls.setItem = function (key, value) {
    var v = typeof value === "string" ? value : String(value);
    origSet(key, v);
    if (!isLocalOnly(key)) queueWrite(key, v);
  };
  ls.removeItem = function (key) {
    origRemove(key);
    if (!isLocalOnly(key)) queueWrite(key, null);
  };
  ls.clear = function () {
    var toDelete = [];
    for (var i = 0; i < ls.length; i++) {
      var k = ls.key(i);
      if (k && !isLocalOnly(k)) toDelete.push(k);
    }
    origClear();
    for (var j = 0; j < toDelete.length; j++) queueWrite(toDelete[j], null);
  };

  // Flush on unload / hidden — best-effort durability.
  function flushSync() {
    var keys = Object.keys(pendingWrites);
    if (keys.length === 0) return;
    var writes = [];
    var deletes = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = pendingWrites[k];
      if (v === null) deletes.push(k);
      else writes.push({ key: k, value: v });
    }
    pendingWrites = Object.create(null);
    try {
      var blob = new Blob(
        [
          JSON.stringify({
            writes: writes,
            deletes: deletes,
            originId: ORIGIN_ID,
          }),
        ],
        { type: "application/json" },
      );
      navigator.sendBeacon && navigator.sendBeacon(API_BASE, blob);
    } catch (e) {}
  }
  window.addEventListener("pagehide", flushSync);
  window.addEventListener("beforeunload", flushSync);

  // ---- Apply remote entries to localStorage ------------------------------
  function applyRemote(entries, opts) {
    opts = opts || {};
    var changed = false;
    var changedKeys = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (isLocalOnly(e.key)) continue;
      var newVal = e.value == null ? null : e.value;
      var oldVal = origGet(e.key);
      if (oldVal === newVal) continue;
      // Echo guard: skip if this looks like our own recent write coming back.
      var lw = lastLocalWrite[e.key];
      if (
        lw &&
        Date.now() - lw.ts < ECHO_GUARD_MS &&
        lw.value === newVal
      ) {
        continue;
      }
      if (newVal == null) origRemove(e.key);
      else origSet(e.key, newVal);
      changed = true;
      changedKeys.push(e.key);
      try {
        var ev = new StorageEvent("storage", {
          key: e.key,
          oldValue: oldVal,
          newValue: newVal,
          storageArea: ls,
          url: location.href,
        });
        window.dispatchEvent(ev);
      } catch (err) {}
    }
    if (changed) {
      // Best-effort UI refresh hooks for known render functions.
      var refreshers = [
        "loadDashboardWarga",
        "loadTabelKKAdmin",
        "loadTabelKas",
        "loadTabelIuran",
        "loadTabelSurat",
        "loadTabelArisan",
        "loadTabelBerita",
        "loadTabelAduan",
        "loadTabelPengurus",
        "loadKopLaporan",
        "loadKoperasiData",
        "loadMutasi",
        "renderNotifikasi",
      ];
      for (var i = 0; i < refreshers.length; i++) {
        var fn = window[refreshers[i]];
        if (typeof fn === "function") {
          try { fn(); } catch (_) {}
        }
      }
      // Lightweight indicator for the user
      try {
        var origin = opts.via || "sync";
        if (window.console && console.debug)
          console.debug("[gt-sync]", origin, "applied", changedKeys.length, "key(s):", changedKeys.join(", "));
      } catch (_) {}
    }
    return changed;
  }

  // ---- Polling (resilience fallback) -------------------------------------
  var sseConnected = false;
  var pollTimer = null;
  var polling = false;

  function pollNow() {
    if (polling) return;
    polling = true;
    var url = serverTime
      ? API_BASE + "?since=" + encodeURIComponent(serverTime)
      : API_BASE;
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (!data) return;
        if (data.serverTime) serverTime = data.serverTime;
        if (data.entries && data.entries.length > 0)
          applyRemote(data.entries, { via: "poll" });
      })
      .catch(function () {})
      .finally(function () {
        polling = false;
      });
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    var ms = sseConnected ? POLL_MS : POLL_MS_NO_SSE;
    pollTimer = setTimeout(function tick() {
      pollNow().finally(function () {
        var nextMs = sseConnected ? POLL_MS : POLL_MS_NO_SSE;
        pollTimer = setTimeout(tick, nextMs);
      });
    }, ms);
  }
  schedulePoll();

  // Immediate sync when tab becomes visible / window regains focus.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      flushSync();
    } else if (document.visibilityState === "visible") {
      pollNow();
      // Reconnect SSE if it dropped while hidden.
      if (!sseConnected) startSSE();
    }
  });
  window.addEventListener("focus", function () { pollNow(); });
  window.addEventListener("online", function () {
    pollNow();
    if (!sseConnected) startSSE();
  });

  // ---- SSE: instant push from server -------------------------------------
  var es = null;
  var sseRetryMs = 1500;
  function startSSE() {
    if (typeof EventSource === "undefined") return;
    try {
      if (es) {
        try { es.close(); } catch (_) {}
        es = null;
      }
      es = new EventSource(SSE_URL);
      es.addEventListener("open", function () {
        sseConnected = true;
        sseRetryMs = 1500;
        // Refresh from REST in case we missed events while disconnected.
        pollNow();
      });
      es.addEventListener("hello", function (ev) {
        try {
          var d = JSON.parse(ev.data || "{}");
          if (d.serverTime) serverTime = d.serverTime;
        } catch (_) {}
      });
      es.addEventListener("kv", function (ev) {
        try {
          var d = JSON.parse(ev.data || "{}");
          if (d.serverTime) serverTime = d.serverTime;
          // Skip broadcasts that originated from THIS tab.
          if (d.originId && d.originId === ORIGIN_ID) return;
          if (d.cleared) {
            // server-wide wipe — just full re-sync
            pollNow();
            return;
          }
          if (Array.isArray(d.entries) && d.entries.length > 0)
            applyRemote(d.entries, { via: "sse" });
        } catch (e) {
          console.warn("[gt-sync] sse parse error", e);
        }
      });
      es.addEventListener("error", function () {
        sseConnected = false;
        try { if (es) es.close(); } catch (_) {}
        es = null;
        // Exponential backoff up to 15s.
        sseRetryMs = Math.min(sseRetryMs * 1.7, 15000);
        setTimeout(startSSE, sseRetryMs);
      });
    } catch (e) {
      console.warn("[gt-sync] sse start failed", e);
      sseConnected = false;
      setTimeout(startSSE, 5000);
    }
  }
  startSSE();

  // Expose a manual force-refresh helper.
  window.__GT_SYNC_REFRESH__ = pollNow;
})();
