/* Replit DB sync layer for Smart Portal RT
   PostgreSQL = single source of truth
*/
(function () {
  if (window.__GT_SYNC_INSTALLED__) return;
  window.__GT_SYNC_INSTALLED__ = true;

  var API_BASE = "/api/kv";
  var KEYS_URL = "/api/kv/keys";
  var SSE_URL = "/api/kv/stream";
  var AUDIT_URL = "/api/audit";

  var POLL_MS = 8000;
  var POLL_MS_NO_SSE = 2500;
  var DEBOUNCE_MS = 500;
  var ECHO_GUARD_MS = 2500;

  var ORIGIN_ID =
    "o-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8);

  window.__GT_SYNC_ORIGIN_ID__ = ORIGIN_ID;

  var LOCAL_ONLY = {
    isLoggedIn:1,
    loggedInAs:1,
    loggedInWarga:1,
    gt_theme:1,
    gt_notif_read:1
  };

  function isLocalOnly(key){
    if(!key) return true;
    if(LOCAL_ONLY[key]) return true;
    if(key.indexOf("gt_local_")===0) return true;
    return false;
  }

  var ls=window.localStorage;
  var origSet=ls.setItem.bind(ls);
  var origRemove=ls.removeItem.bind(ls);
  var origClear=ls.clear.bind(ls);
  var origGet=ls.getItem.bind(ls);

  var serverTime=null;
  var bootOverlay=null;

function ensureBootOverlay(){
if(bootOverlay&&bootOverlay.parentNode) return bootOverlay;
})();
