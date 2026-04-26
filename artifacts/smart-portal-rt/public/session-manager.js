/* Session Manager for Smart Portal RT
   Handles authentication without relying on localStorage for sensitive data.
   Session token is stored as an in-memory JavaScript variable for current tab.
   Each tab maintains its own session independently.
*/
(function () {
  if (window.__GT_SESSION_INSTALLED__) return;
  window.__GT_SESSION_INSTALLED__ = true;

  var sessionToken = null;
  var sessionRole = null;
  var sessionExpiresAt = null;

  // Try to load session from sessionStorage as fallback (available in incognito)
  function tryLoadSessionStorage() {
    try {
      var stored = window.sessionStorage.getItem("gt_session_token");
      if (stored) {
        var parts = stored.split("|");
        if (parts.length === 3) {
          sessionToken = parts[0];
          sessionRole = parts[1];
          sessionExpiresAt = new Date(parts[2]);
          console.log("[gt-session] Loaded session from sessionStorage");
          return true;
        }
      }
    } catch (e) {
      console.debug("[gt-session] sessionStorage unavailable (private mode?)");
    }
    return false;
  }

  // Store session in sessionStorage if available
  function storeSessionStorage() {
    if (!sessionToken) return;
    try {
      var value = sessionToken + "|" + sessionRole + "|" + sessionExpiresAt.toISOString();
      window.sessionStorage.setItem("gt_session_token", value);
    } catch (e) {
      console.debug("[gt-session] Cannot store in sessionStorage");
    }
  }

  // Clear session storage
  function clearSessionStorage() {
    try {
      window.sessionStorage.removeItem("gt_session_token");
    } catch (e) {
      console.debug("[gt-session] Cannot clear sessionStorage");
    }
  }

  // Login: authenticate and get session token
  window.__GT_LOGIN__ = function (role, password) {
    return fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: role, password: password }),
    })
      .then(function (r) {
        if (r.ok) {
          return r.json();
        } else {
          return r.json().then(function (data) {
            throw new Error(data.error || "Login failed");
          });
        }
      })
      .then(function (data) {
        sessionToken = data.token;
        sessionRole = data.role;
        sessionExpiresAt = new Date(data.expiresAt);
        storeSessionStorage();
        console.log("[gt-session] Login successful as", sessionRole);
        return data;
      });
  };

  // Logout: invalidate session
  window.__GT_LOGOUT__ = function () {
    if (!sessionToken) return Promise.resolve();

    var token = sessionToken;
    sessionToken = null;
    sessionRole = null;
    sessionExpiresAt = null;
    clearSessionStorage();

    return fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token }),
    })
      .then(function (r) {
        return r.json();
      })
      .catch(function (err) {
        console.warn("[gt-session] Logout error:", err);
      });
  };

  // Get current session token
  window.__GT_GET_SESSION__ = function () {
    if (!sessionToken) {
      tryLoadSessionStorage();
    }
    if (sessionToken && new Date() > sessionExpiresAt) {
      console.warn("[gt-session] Session expired");
      sessionToken = null;
      sessionRole = null;
      sessionExpiresAt = null;
      clearSessionStorage();
      return null;
    }
    return sessionToken;
  };

  // Get current role
  window.__GT_GET_ROLE__ = function () {
    window.__GT_GET_SESSION__(); // Refresh if needed
    return sessionRole;
  };

  // Check if user is authenticated
  window.__GT_IS_AUTHENTICATED__ = function () {
    return !!window.__GT_GET_SESSION__();
  };

  // Try to load session on script load
  tryLoadSessionStorage();

  console.log("[gt-session] Session manager initialized");
})();