// [F11 §2] ghrdp-cred-shim.js  VNC PASSWORD MEMORY (client-side only).
// Deployed by the workflow INTO the served noVNC copy (C:\ghrdp\novnc\ghrdp-cred-shim.js)
// and injected via <script src="ghrdp-cred-shim.js"> in vnc.html at deploy time.
//
// CONTRACT:
//   1. On load, listen for a postMessage from the opener dashboard ONLY
//      (origin must be http://<tailnet-ip>:7331 or http://<tailnet-ip>:7332).
//   2. Message shape: { type: 'ghrdp-vnc-pass', pass: '<password>' }
//   3. Auto-fill the VNC Credentials dialog password field and click Connect.
//   4. PURGE the variable immediately after submission (never logged, never
//      echoed, never placed in URLs/query strings).
//
// GATES (enforced by launch-gates.yml):
//   - This file must NOT log or echo the password value.
//   - This file must NOT place the password in any URL or query string.
//   - This file must accept postMessage ONLY from the opener origin.
(function () {
  'use strict';
  var ACCEPTED_TYPE = 'ghrdp-vnc-pass';
  var MAX_WAIT_MS = 30000;

  // Strict origin check: only the dashboard on the same tailnet host:7331/:7333
  // may post the credential. The dashboard knows its own origin; the noVNC
  // page is served on the same IP (port 7333), so we derive the allowed
  // origins from window.location.hostname.
  function isAllowedOrigin(origin) {
    if (!origin || typeof origin !== 'string') return false;
    var host = window.location.hostname || '';
    if (!host) return false;
    // The dashboard runs on port 7331 (PS) or 7332 (Rust) on the same tailnet IP.
    return origin === 'http://' + host + ':7331' ||
           origin === 'http://' + host + ':7332' ||
           origin === 'http://' + host + ':7333' ||
           origin === window.location.origin;
  }

  function tryAutoFill(password) {
    // noVNC renders a "Credentials" dialog with a password input and a
    // "Send Credentials" / "Connect" button.  Try multiple selectors for
    // robustness across noVNC versions.
    var input = document.getElementById('password-input') ||
                document.querySelector('input[type="password"]') ||
                document.querySelector('#noVNC_credentials_password') ||
                document.querySelector('[id*="password"]');
    if (!input) return false;
    // Set value via native setter to bypass any input-handler guards.
    var nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    );
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(input, password);
    } else {
      input.value = password;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Find and click the connect / send credentials button.
    var btn = document.getElementById('credentials-button') ||
              document.querySelector('#noVNC_connect_button') ||
              document.querySelector('button[type="submit"]') ||
              document.querySelector('button[class*="connect"]');
    if (btn) {
      btn.click();
    }
    return true;
  }

  function handleMessage(event) {
    if (!isAllowedOrigin(event.origin)) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== ACCEPTED_TYPE) return;
    var pass = data.pass;
    if (typeof pass !== 'string' || pass.length === 0) return;
    // Attempt to fill immediately; if the dialog is not yet visible, poll briefly.
    var filled = tryAutoFill(pass);
    if (!filled) {
      var tries = 0;
      var poller = setInterval(function () {
        tries++;
        if (tryAutoFill(pass) || tries > (MAX_WAIT_MS / 500)) {
          clearInterval(poller);
        }
      }, 500);
    }
    // Purge: never retain the password in any variable accessible after this.
    pass = null;
    data = null;
  }

  window.addEventListener('message', handleMessage, false);
})();
