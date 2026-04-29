/* Replit DB sync layer for Smart Portal RT.

   Centralised PostgreSQL is the single source of truth.
   localStorage is ONLY a runtime materialised view of the server state — it is
   never used as a fallback, never used as a primary store, and is reconciled
   on every boot (added + removed keys).

   Guarantees:
   - Boot is BLOCKING: app cannot start until the server snapshot has been
     loaded successfully. If the network/server is down, an overlay with a
     Retry button is shown. The app NEVER runs from a stale local cache.
   - Boot RECONCILES: any non-local key in localStorage that does not exist on
     the server is removed. Server-side deletions always win.
   - Every write to non-local keys goes through PUT /api/kv (debounced 50 ms,
     re-queued on failure, sendBeacon-flushed on unload).
   - SSE stream (/api/kv/stream) pushes other clients' writes instantly.
   - Polling (/api/kv?since=...) is a resilience fallback.
   - Visibility / focus / online listeners trigger an instant poll + key
     reconciliation to catch missed updates.
   - A persistent status pill shows the connection state and pending writes.
*/
(function () {
  if (window.__GT_SYNC_INSTALLED__) return;
  window.__GT_SYNC_INSTALLED__ = true;

  var API_BASE = "/api/kv";
  var KEYS_URL = "/api/kv/keys";
  var SSE_URL = "/api/kv/stream";
  var AUDIT_URL = "/api/audit";
  var POLL_MS = 8000; // fallback polling (SSE handles real-time)
  var POLL_MS_NO_SSE = 2500; // faster polling when SSE is down
  var DEBOUNCE_MS = 500; // outbound write debounce — near-immediate
  var ECHO_GUARD_MS = 2500; // skip echoes of our own writes (matched by value)

  // Unique id per browser tab — server attaches this to broadcasts.
  var ORIGIN_ID =
    "o-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  window.__GT_SYNC_ORIGIN_ID__ = ORIGIN_ID;

  // Keys that are purely local/UI state — not synced across devices.
  // Everything else lives on the server.
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

  // ---- Boot phase: blocking load from server (NO local fallback) ----------
  var serverTime = null;
  var bootOverlay = null;

  function ensureBootOverlay() {
    if (bootOverlay && document.body && bootOverlay.parentNode) return bootOverlay;
    var host = document.body || document.documentElement;
    if (!host) return null;
    if (bootOverlay && bootOverlay.parentNode !== host) {
      try {
        bootOverlay.parentNode && bootOverlay.parentNode.removeChild(bootOverlay);
      } catch (_) {}
      bootOverlay = null;
    }
    if (bootOverlay) return bootOverlay;
    var el = document.createElement("div");
    el.id = "__gt_sync_overlay__";
    el.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(255,255,255,0.96);display:flex;align-items:center;justify-content:center;font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;";
    el.innerHTML =
      '<div style="text-align:center;max-width:340px;padding:24px;border:1px solid #e2e8f0;border-radius:14px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,0.08)">' +
      '<div id="__gt_sync_spin__" style="width:42px;height:42px;border:4px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:gtspin 0.9s linear infinite;margin:0 auto 14px"></div>' +
      '<div id="__gt_sync_msg__" style="font-weight:600;margin-bottom:6px">Memuat data dari server…</div>' +
      '<div id="__gt_sync_sub__" style="color:#64748b;font-size:12px;line-height:1.5">Aplikasi terhubung ke PostgreSQL pusat. Mohon tunggu.</div>' +
      '<button id="__gt_sync_retry__" style="display:none;margin-top:14px;padding:8px 14px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer">Coba lagi</button>' +
      '</div><style>@keyframes gtspin{to{transform:rotate(360deg)}}</style>';
    host.appendChild(el);
    bootOverlay = el;
    var btn = el.querySelector("#__gt_sync_retry__");
    if (btn) {
      btn.addEventListener("click", function () {
        setBootStatus("loading", "Mencoba ulang…", "Menghubungi server PostgreSQL.");
        bootLoad();
      });
    }
    return el;
  }

  function setBootStatus(state, msg, sub) {
    var el = ensureBootOverlay();
    if (!el) return;
    var spin = el.querySelector("#__gt_sync_spin__");
    var m = el.querySelector("#__gt_sync_msg__");
    var s = el.querySelector("#__gt_sync_sub__");
    var btn = el.querySelector("#__gt_sync_retry__");
    if (m && msg) m.textContent = msg;
    if (s && sub) s.textContent = sub;
    if (state === "error") {
      if (spin) spin.style.display = "none";
      if (btn) btn.style.display = "inline-block";
      if (m) m.style.color = "#b91c1c";
    } else {
      if (spin) spin.style.display = "block";
      if (btn) btn.style.display = "none";
      if (m) m.style.color = "#0f172a";
    }
  }

  function hideBootOverlay() {
    if (bootOverlay && bootOverlay.parentNode) {
      bootOverlay.parentNode.removeChild(bootOverlay);
    }
    bootOverlay = null;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (!window.__GT_SYNC_BOOTED__) ensureBootOverlay();
    });
  } else {
    ensureBootOverlay();
  }

  /**
   * Boot load. Tries a SYNCHRONOUS XHR first (so all inline scripts that
   * follow this file see a populated localStorage), and falls back to an
   * ASYNCHRONOUS fetch when the browser blocks sync XHR on the main thread
   * — this is what was breaking fresh devices in iOS Safari Private mode,
   * PWA contexts and some Android incognito modes, where sync XHR throws
   * (or silently returns status 0) and used to leave the app stuck on the
   * "Memuat data dari server…" overlay.
   *
   * Either path enforces the same invariant: PostgreSQL is the only source
   * of truth — there is no local-only fallback. The overlay stays up until
   * the server snapshot has been applied.
   *
   * After the async fallback path applies data, runRefreshers() is called
   * so any inline UI loader that already ran (against empty localStorage,
   * because the parser did NOT block) is re-rendered with the real data.
   */
  function applyBootData(data, viaAsync) {
    serverTime = data.serverTime || new Date().toISOString();
    var entries = data.entries || [];
    var serverKeys = Object.create(null);

    // Apply server entries.
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (isLocalOnly(e.key)) continue;
      serverKeys[e.key] = 1;
      if (e.value == null) origRemove(e.key);
      else origSet(e.key, e.value);
    }

    // Reconciliation: prune any non-local localStorage keys NOT present on
    // the server. Without this, deletes that happened while this device was
    // offline would leave stale shared records in the local mirror.
    var staleKeys = [];
    for (var j = 0; j < ls.length; j++) {
      var k = ls.key(j);
      if (!k) continue;
      if (isLocalOnly(k)) continue;
      if (!serverKeys[k]) staleKeys.push(k);
    }
    for (var s = 0; s < staleKeys.length; s++) origRemove(staleKeys[s]);

    window.__GT_SYNC_BOOTED__ = true;
    window.__GT_SYNC_BOOT_TIME__ = serverTime;
    window.__GT_SYNC_BOOT_ENTRY_COUNT__ = entries.length;
    if (staleKeys.length > 0) {
      console.info(
        "[gt-sync] boot pruned %d stale local key(s): %s",
        staleKeys.length,
        staleKeys.join(", "),
      );
    }
    console.info(
      "%c✓ Smart Portal RT terhubung ke PostgreSQL pusat — multi-device realtime sync aktif (%d entries dari server, t=%s%s)",
      "color:#16a34a;font-weight:600",
      entries.length,
      serverTime,
      viaAsync ? ", boot=async" : "",
    );
    hideBootOverlay();

    // Fire a one-shot event + re-run UI loaders. On the SYNC path this is a
    // no-op (loaders haven't run yet). On the ASYNC path this is what makes
    // fresh devices on iOS Safari Private / PWA actually see the data,
    // because their inline scripts ran with empty localStorage.
    if (viaAsync) {
      try {
        window.dispatchEvent(new Event("__gt-sync-booted"));
      } catch (_) {}
      try {
        runRefreshers();
      } catch (_) {}
    }
  }

  function bootLoadAsync() {
    function bootLoadAsync() {

  fetch(API_BASE,{
    headers:{
      Accept:"application/json",
      "Cache-Control":"no-cache"
    },
    credentials:"same-origin",
    cache:"no-store"
  })

  .then(function(r){

    if(!r.ok){
      var err = new Error("HTTP "+r.status);
      err.__status = r.status;
      throw err;
    }

    return r.json();

  })

  .then(function(data){
    applyBootData(data,true);
  })

  .catch(function(err){

    console.error("[gt-sync] async boot failed:",err);

    setBootStatus(
      "error",
      "Tidak bisa menghubungi server",
      "Silakan coba lagi"
    );

  });

}      

  function bootLoad() {
    // 1) Try sync XHR first — preferred because it blocks the HTML parser,
    //    so every inline script that follows _sync.js sees a fully populated
    //    localStorage. Works on virtually all desktop browsers.
    var xhr = new XMLHttpRequest();
    var syncBlocked = false;
    try {
      xhr.open("GET", API_BASE, false); // synchronous
      xhr.setRequestHeader("Accept", "application/json");
      xhr.send(null);
    } catch (err) {
      // 2) Sync XHR is forbidden in this context (iOS Safari Private,
      //    PWA service-worker controlled page, some Android private modes,
      //    or strict CSP). Fall back to async fetch.
      syncBlocked = true;
      console.warn(
        "[gt-sync] sync boot rejected by browser, falling back to async fetch:",
        (err && err.message) || err,
      );
    }

    // Some browsers silently complete sync XHR with status 0 instead of
    // throwing. Treat that as "blocked" too.
    if (!syncBlocked && xhr.status === 0) {
      syncBlocked = true;
      console.warn(
        "[gt-sync] sync boot returned status 0, falling back to async fetch",
      );
    }

    if (syncBlocked) {
      setBootStatus(
        "loading",
        "Memuat data dari server…",
        "Aplikasi terhubung ke PostgreSQL pusat. Mohon tunggu.",
      );
      bootLoadAsync();
      return;
    }

    if (!(xhr.status >= 200 && xhr.status < 300)) {
      console.error("[gt-sync] boot load failed:", xhr.status);
      setBootStatus(
        "error",
        "Server menolak permintaan (" + xhr.status + ")",
        "Server pusat tersedia tetapi mengembalikan error. Silakan coba lagi.",
      );
      return;
    }

    var data;
    try {
      data = JSON.parse(xhr.responseText);
    } catch (e) {
      console.error("[gt-sync] boot parse error:", e);
      setBootStatus(
        "error",
        "Respons server tidak valid",
        "Tidak dapat memuat data. Coba lagi dalam beberapa saat.",
      );
      return;
    }

    applyBootData(data, false);
  }
  bootLoad();

  // ---- Status pill -------------------------------------------------------
  var pill = null;
  var pillState = { mode: "syncing", lastSync: null, pending: 0 };

  function ensurePill() {
    if (pill && pill.parentNode) return pill;
    var host = document.body || document.documentElement;
    if (!host) return null;
    pill = document.createElement("div");
    pill.id = "__gt_sync_pill__";
    pill.style.cssText =
      "position:fixed;right:10px;bottom:10px;z-index:2147483646;background:rgba(15,23,42,0.86);color:#fff;font:600 11px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:6px 10px;border-radius:999px;box-shadow:0 4px 14px rgba(15,23,42,0.18);display:flex;align-items:center;gap:6px;backdrop-filter:saturate(140%) blur(6px);cursor:pointer;user-select:none;";
    pill.title = "Klik untuk sinkron paksa dengan PostgreSQL pusat";
    pill.addEventListener("click", function () {
      try {
        pollNow();
      } catch (_) {}
    });
    host.appendChild(pill);
    return pill;
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      var hh = String(d.getHours()).padStart(2, "0");
      var mm = String(d.getMinutes()).padStart(2, "0");
      var ss = String(d.getSeconds()).padStart(2, "0");
      return hh + ":" + mm + ":" + ss;
    } catch (_) {
      return "—";
    }
  }

  function renderPill() {
    var el = ensurePill();
    if (!el) return;
    var dot, label, bg;
    if (pillState.mode === "offline") {
      dot = "●";
      bg = "rgba(185,28,28,0.92)";
      label =
        "Offline — menyambung ulang" +
        (pillState.pending ? " · " + pillState.pending + " pending" : "");
    } else if (pillState.mode === "syncing") {
      dot = "⟳";
      bg = "rgba(217,119,6,0.92)";
      label =
        "Syncing…" +
        (pillState.pending ? " · " + pillState.pending + " pending" : "");
    } else {
      dot = "●";
      bg = "rgba(22,101,52,0.92)";
      label =
        "Online · " +
        fmtTime(pillState.lastSync || serverTime) +
        (pillState.pending ? " · " + pillState.pending + " pending" : "");
    }
    el.style.background = bg;
    el.textContent = dot + " " + label;
  }

  function setPill(patch) {
    var changed = false;
    for (var k in patch) {
      if (pillState[k] !== patch[k]) {
        pillState[k] = patch[k];
        changed = true;
      }
    }
    if (changed) renderPill();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      ensurePill();
      renderPill();
    });
  } else {
    ensurePill();
    renderPill();
  }

  // ---- Write queue -------------------------------------------------------
  var pendingWrites = Object.create(null); // key -> value (string | null for delete)
  var lastLocalWrite = Object.create(null); // key -> { value, ts }
  var flushTimer = null;
  var flushing = false;

  function pendingCount() {
    var n = 0;
    for (var _ in pendingWrites) n++;
    return n;
  }

  function scheduleFlush() {
    setPill({ pending: pendingCount() });
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
    if (keys.length === 0) {
      setPill({ pending: 0 });
      return;
    }
    var writes = [];
    var deletes = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = pendingWrites[k];
      if (v === null) deletes.push(k);
      else writes.push({ key: k, value: v });
    }
    
    flushing = true;
    setPill({ mode: "syncing", pending: writes.length + deletes.length });
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
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      function flush(){

 if(flushing) return;

 var keys=Object.keys(pendingWrites);

 if(!keys.length){
   setPill({pending:0});
   return;
 }

 var writes=[];
 var deletes=[];

 for(var i=0;i<keys.length;i++){

   var k=keys[i];
   var v=pendingWrites[k];

   if(v===null)
      deletes.push(k);
   else
      writes.push({
        key:k,
        value:v
      });

 }

 flushing=true;

 setPill({
   mode:"syncing",
   pending:keys.length
 });

 fetch(API_BASE,{
   method:"PUT",
   headers:{
      "Content-Type":"application/json"
   },
   body:JSON.stringify({
      writes:writes,
      deletes:deletes,
      originId:ORIGIN_ID
   })
 })

 .then(function(r){

   if(!r.ok)
      throw new Error("HTTP "+r.status);

   return r.json();

 })

 .then(function(resp){

    if(resp.serverTime)
       serverTime=resp.serverTime;

    for(var i=0;i<keys.length;i++){
      delete pendingWrites[keys[i]];
    }

    setPill({
      mode:"online",
      lastSync:serverTime,
      pending:pendingCount()
    });

 })

 .catch(function(err){

   console.warn("[gt-sync] flush failed:",err);

   setPill({
      mode:"offline",
      pending:pendingCount()
   });

 })

 .finally(function(){

   flushing=false;

   if(pendingCount()>0){
      setTimeout(flush,800);
   }

 });

}

  // ---- Wrap localStorage --------------------------------------------------
  // The wrapper guarantees server-write-through: any application code that
  // writes to localStorage immediately schedules the same write to PostgreSQL.
  // The local copy is purely a synchronous mirror of the server.
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

  // Best-effort durability — flush on unload / hidden via sendBeacon.
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

  function runRefreshers() {
    for (var i = 0; i < refreshers.length; i++) {
      var fn = window[refreshers[i]];
      if (typeof fn === "function") {
        try {
          fn();
        } catch (_) {}
      }
    }
  }

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
      if (lw && Date.now() - lw.ts < ECHO_GUARD_MS && lw.value === newVal) {
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
      runRefreshers();
      try {
        if (window.console && console.debug)
          console.debug(
            "[gt-sync]",
            opts.via || "sync",
            "applied",
            changedKeys.length,
            "key(s):",
            changedKeys.join(", "),
          );
      } catch (_) {}
    }
    return changed;
  }

  /**
   * Reconcile local key set against the server's authoritative key list.
   * Removes any non-local key in localStorage that the server no longer has.
   * Run on every focus / visibility / online event.
   */
  function reconcileKeys() {
    return fetch(KEYS_URL, { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.keys)) return;
        var serverKeys = Object.create(null);
        for (var i = 0; i < data.keys.length; i++) serverKeys[data.keys[i]] = 1;
        var pruned = [];
        // Snapshot current keys first because removeItem mutates the index.
        var localKeys = [];
        for (var j = 0; j < ls.length; j++) {
          var k = ls.key(j);
          if (k) localKeys.push(k);
        }
        for (var p = 0; p < localKeys.length; p++) {
          var lk = localKeys[p];
          if (isLocalOnly(lk)) continue;
          if (!serverKeys[lk]) {
            origRemove(lk);
            pruned.push(lk);
          }
        }
        if (pruned.length > 0) {
          console.info(
            "[gt-sync] reconcile pruned %d stale key(s): %s",
            pruned.length,
            pruned.join(", "),
          );
          runRefreshers();
        }
      })
      .catch(function () {});
  }

  // ---- Polling (resilience fallback) -------------------------------------
  var sseConnected = false;
  var pollTimer = null;
  var polling = false;

  function pollNow() {
    if (polling) return Promise.resolve();
    polling = true;
    var url = API_BASE;

if(serverTime){

  var t=new Date(serverTime);

  t=new Date(
    t.getTime()-5000
  ); // overlap 5 detik anti missed updates

  url=
    API_BASE+
    "?since="+
    encodeURIComponent(
      t.toISOString()
    );
}
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.serverTime) serverTime = data.serverTime;
        if (data.entries && data.entries.length > 0)
          applyRemote(data.entries, { via: "poll" });
        setPill({
          mode: "online",
          lastSync: serverTime,
          pending: pendingCount(),
        });
      })
      .catch(function () {
        setPill({ mode: "offline", pending: pendingCount() });
      })
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

  // Immediate sync + reconcile when tab becomes visible / window regains focus.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      flushSync();
    } else if (document.visibilityState === "visible") {
      pollNow().then(reconcileKeys);
      if (!sseConnected) startSSE();
    }
  });
  window.addEventListener("focus", function () {
    pollNow().then(reconcileKeys);
  });
  window.addEventListener("online", function () {
    pollNow().then(reconcileKeys);
    if (!sseConnected) startSSE();
  });
  window.addEventListener("offline", function () {
    setPill({ mode: "offline", pending: pendingCount() });
  });

  // ---- SSE: instant push from server -------------------------------------
  var es = null;
  var sseRetryMs = 3000;
  var sseReconnectTimer = null;
  var sseConnecting = false;
  function startSSE() {

 if (sseConnecting || es) return;

 sseConnecting = true;
    if (typeof EventSource === "undefined") return;
    try {
      if (es) {
        try {
          es.close();
        } catch (_) {}
        es = null;
      }
      es = new EventSource(SSE_URL + "?t=" + Date.now());
      es.addEventListener("open", function () {

  sseConnecting=false;

  if(sseReconnectTimer){
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer=null;
  }

  sseConnected=true;
        sseConnected = true;
        sseRetryMs = 1500;
        setPill({
          mode: "online",
          lastSync: serverTime,
          pending: pendingCount(),
        });
        // Refresh from REST + reconcile in case we missed events while disconnected.
        pollNow().then(reconcileKeys);
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
          if (d.originId && d.originId === ORIGIN_ID) {
            setPill({
              mode: "online",
              lastSync: serverTime,
              pending: pendingCount(),
            });
            return;
          }
          if (d.cleared) {
            // server-wide wipe — full re-sync + reconcile
            pollNow().then(reconcileKeys);
            return;
          }
          if (Array.isArray(d.entries) && d.entries.length > 0) {
            applyRemote(d.entries, { via: "sse" });
            setPill({
              mode: "online",
              lastSync: serverTime,
              pending: pendingCount(),
            });
          }
        } catch (e) {
          console.warn("[gt-sync] sse parse error", e);
        }
      });
      es.addEventListener("error", function () {

  if (sseReconnectTimer) return; // cegah reconnect ganda

  sseConnected = false;
  sseConnecting = false;

  try {
    if (es) es.close();
  } catch (_) {}

  es = null;

  setPill({
    mode: "offline",
    pending: pendingCount()
  });

  // exponential backoff
  sseRetryMs = Math.min(
    sseRetryMs * 1.7,
    15000
  );

  sseReconnectTimer = setTimeout(function () {

    sseReconnectTimer = null;
    startSSE();

  }, sseRetryMs);

});

} catch (err) {

  console.warn("[gt-sync] SSE init failed", err);

  sseConnecting = false;
  sseConnected = false;

  if (!sseReconnectTimer) {
    sseReconnectTimer = setTimeout(function () {

      sseReconnectTimer = null;
      startSSE();

    }, sseRetryMs);
  }

}

} // <-- penutup function startSSE()

  // Expose helpers.
  window.__GT_SYNC_REFRESH__ = function () {
    return pollNow().then(reconcileKeys);
  };
  window.__GT_SYNC_AUDIT__ = function () {
    return fetch(AUDIT_URL).then(function (r) {
      return r.json();
    });
  };
})();
