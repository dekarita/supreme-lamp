// [F11 §2] GHRDP VNC password memory shim - CLIENT-SIDE ONLY.
//
// Deployed by main.yml into the served noVNC copy (C:\ghrdp\novnc) and loaded
// by an injected <script> tag at the END of vnc.html. The dashboard opens
// noVNC as a popup/window and postMessages the remembered password with an
// EXACT targetOrigin; this shim:
//   1. announces {type:'ghrdp-cred-shim-ready'} to its opener on load,
//   2. accepts {type:'ghrdp-vnc-pass', pass} ONLY from the opener window
//      (event.source === window.opener) AND only when event.origin === the
//      deploy-stamped dashboard origin window.__GHRDP_DASH_ORIGIN__
//      (http://<tailnet-ip>:7331) AND the document referrer agrees,
//   3. waits for the real noVNC Credentials dialog (#noVNC_credentials_dlg),
//      auto-fills #noVNC_password_input, submits #noVNC_credentials_button,
//      acks {type:'ghrdp-vnc-pass-ok'}, and purges the variable,
//   4. relays a password the USER typed once back to the dashboard
//      {type:'ghrdp-vnc-pass-store'} so it can be remembered in localStorage.
//
// GATES (tests/f11-ux.test.js): never in URLs/query strings, never logged
// (no console.*), never exfiltrated (no fetch/XHR/WebSocket/location), never
// echoed in the ack. If the dashboard origin was not stamped, only a strict
// http://<100.64-127.x.x>:7331 opener origin is trusted (tailnet CGNAT).
(function () {
  'use strict';
  var pass = null;      // pending password (purged after submit / unload)
  var injected = null;  // value we auto-filled (never re-relayed)
  var CGNAT_7331 = /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}:7331$/;

  function allowedOrigin() {
    var stamped = typeof window.__GHRDP_DASH_ORIGIN__ === 'string' ? window.__GHRDP_DASH_ORIGIN__ : '';
    if (stamped) return stamped;
    // fallback: tailnet dashboard only (never a wildcard)
    try {
      var ref = document.referrer || '';
      if (!ref) return '';
      var u = new URL(ref);
      if (u.protocol === 'http:' && CGNAT_7331.test(u.origin)) return u.origin;
    } catch (_) { }
    return '';
  }

  function embedHost() {
    if (window.opener) return window.opener;
    try { if (window.parent && window.parent !== window) return window.parent; } catch (_) { }
    return null;
  }

  function sendToOpener(msg) {
    var target = allowedOrigin();
    var host = embedHost();
    if (!target || !host) return false;
    try { host.postMessage(msg, target); return true; } catch (_) { return false; }
  }

  function accepted(ev) {
    var target = allowedOrigin();
    if (!target) return false;
    if (ev.origin !== target) return false;
    var host = embedHost();
    if (!host || ev.source !== host) return false;
    return true;
  }

  function visible(el) {
    try { return !!(el && el.getClientRects && el.getClientRects().length); } catch (_) { return false; }
  }

  function fillAndSubmit() {
    if (pass === null) return false;
    var dlg = document.getElementById('noVNC_credentials_dlg');
    var input = document.getElementById('noVNC_password_input');
    var btn = document.getElementById('noVNC_credentials_button');
    if (!visible(dlg) || !visible(input) || !visible(btn)) return false;
    var v = pass;
    try {
      input.value = v;
      var ev;
      try { ev = new Event('input', { bubbles: true }); } catch (_) { ev = document.createEvent('Event'); ev.initEvent('input', true, true); }
      input.dispatchEvent(ev);
      injected = v;   // mark before submit so our own relay listener skips it
      pass = null;    // purge the pending copy
      if (btn.form && btn.form.requestSubmit) { btn.form.requestSubmit(btn); }
      else { btn.click(); }
      sendToOpener({ type: 'ghrdp-vnc-pass-ok' });
      return true;
    } catch (_) {
      pass = v; // keep trying on the next tick
      return false;
    }
  }

  // Capture a password the USER typed (once) -> hand it back to the
  // dashboard for localStorage. Runs before noVNC's own submit handler.
  document.addEventListener('submit', function (ev) {
    try {
      var form = ev.target;
      var dlg = document.getElementById('noVNC_credentials_dlg');
      if (!form || !dlg || !dlg.contains(form)) return;
      var input = document.getElementById('noVNC_password_input');
      if (!input) return;
      var v = input.value;
      if (!v || v === injected) return; // never re-relay our own fill
      injected = v;
      sendToOpener({ type: 'ghrdp-vnc-pass-store', pass: v });
    } catch (_) { }
  }, true);

  window.addEventListener('message', function (ev) {
    if (!accepted(ev)) return;
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'ghrdp-vnc-pass' && typeof d.pass === 'string' && d.pass) {
      pass = d.pass; // held in this closure only - never stored, never logged
      fillAndSubmit();
    }
  });

  function purge() { pass = null; injected = null; }
  window.addEventListener('pagehide', purge);
  window.addEventListener('beforeunload', purge);

  // Auto-fill retry while the dialog is not up yet (RFB handshake takes a
  // moment after connect); stops as soon as the value is submitted.
  setInterval(function () { if (pass !== null) fillAndSubmit(); }, 300);

  sendToOpener({ type: 'ghrdp-cred-shim-ready' });
})();
