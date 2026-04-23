/* Replit DB sync layer for Smart Portal RT.
   - Loads server state into localStorage before the rest of the app runs (sync XHR).
   - Wraps localStorage.setItem/removeItem/clear so writes are pushed to server (debounced batch).
   - Polls server every few seconds and applies changes from other devices to localStorage,
     dispatching native `storage` events so existing reactive code can pick them up.
*/
(function () {
  if (window.__GT_SYNC_INSTALLED__) return;
  window.__GT_SYNC_INSTALLED__ = true;

  var API_BASE = "/api/kv";
  var POLL_MS = 5000;
  var DEBOUNCE_MS = 600;
  var ECHO_GUARD_MS = 4000;

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

  // Body may not exist yet if this runs in <head>; defer overlay until DOM is ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      // overlay is auto-hidden once boot completes; only show if still booting.
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
          if (e.value == null) {
            origRemove(e.key);
          } else {
            origSet(e.key, e.value);
          }
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
  var lastLocalWrite = Object.create(null); // key -> timestamp (echo guard)
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
      body: JSON.stringify({ writes: writes, deletes: deletes }),
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (resp) {
        if (resp && resp.serverTime) serverTime = resp.serverTime;
      })
      .catch(function (err) {
        console.warn("[gt-sync] flush failed, re-queueing:", err);
        // Re-queue dropped writes (latest pending wins)
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
    lastLocalWrite[key] = Date.now();
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
    // Snapshot non-local-only keys first to delete them remotely.
    var toDelete = [];
    for (var i = 0; i < ls.length; i++) {
      var k = ls.key(i);
      if (k && !isLocalOnly(k)) toDelete.push(k);
    }
    origClear();
    for (var j = 0; j < toDelete.length; j++) {
      queueWrite(toDelete[j], null);
    }
  };

  // Flush on unload / visibility change
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
        [JSON.stringify({ writes: writes, deletes: deletes })],
        { type: "application/json" },
      );
      navigator.sendBeacon && navigator.sendBeacon(API_BASE, blob);
    } catch (e) {}
  }
  window.addEventListener("pagehide", flushSync);
  window.addEventListener("beforeunload", flushSync);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushSync();
  });

  // ---- Polling for remote changes -----------------------------------------
  function applyRemote(entries) {
    var changed = false;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (isLocalOnly(e.key)) continue;
      // Echo guard: skip if we wrote this key very recently.
      var lw = lastLocalWrite[e.key] || 0;
      if (Date.now() - lw < ECHO_GUARD_MS) continue;
      var oldVal = origGet(e.key);
      var newVal = e.value == null ? null : e.value;
      if (oldVal === newVal) continue;
      if (newVal == null) origRemove(e.key);
      else origSet(e.key, newVal);
      changed = true;
      // Dispatch a storage event so listeners (if any) can react.
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
      try {
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
          "renderNotifikasi",
        ];
        for (var i = 0; i < refreshers.length; i++) {
          var fn = window[refreshers[i]];
          if (typeof fn === "function") {
            try {
              fn();
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  }
  var origGet = ls.getItem.bind(ls);

  function poll() {
    var url = serverTime
      ? API_BASE + "?since=" + encodeURIComponent(serverTime)
      : API_BASE;
    fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (!data) return;
        if (data.serverTime) serverTime = data.serverTime;
        if (data.entries && data.entries.length > 0) applyRemote(data.entries);
      })
      .catch(function () {})
      .finally(function () {
        setTimeout(poll, POLL_MS);
      });
  }
  setTimeout(poll, POLL_MS);
})();
