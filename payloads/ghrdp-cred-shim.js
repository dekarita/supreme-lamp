/* ghrdp-cred-shim.js  [F11-2 §2, F13-3]  VNC password handoff shim (client-side only).
 *
 * WHAT IT DOES
 *   Deployed INTO the served noVNC copy (C:\ghrdp\novnc\ghrdp-cred-shim.js) and
 *   referenced by a <script src="ghrdp-cred-shim.js"></script> the webdesk
 *   deploy injects before </body> of vnc.html. It listens for
 *       postMessage({ type: 'ghrdp-vnc-pass', pass: '...' })
 *   that is accepted ONLY when ALL of these hold:
 *     - ev.source === window.opener (the Mission Control dashboard tab),
 *     - ev.origin is byte-equal to an origin listed in the page's
 *       <meta name="ghrdp-cred-origin"> (written by the deploy step as the
 *       EXACT dashboard origin, e.g. http://100.118.42.7:7331),
 *     - the payload is a non-empty string <= 1024 chars.
 *   It then auto-submits the noVNC Credentials dialog and PURGES the local
 *   variable immediately.
 *
 * [F13-3] SELECTORS ARE PINNED TO THE DEPLOYED noVNC VERSION. main.yml clones
 *   noVNC with `--branch v1.7.0` (never a moving master), where:
 *     - the credentials dialog is <div id="noVNC_credentials_dlg"> and opens
 *       with the class `noVNC_open` on the RFB `credentialsrequired` event,
 *     - the password field is <input id="noVNC_password_input">,
 *     - the submit control is <input id="noVNC_credentials_button"
 *       type="submit"> (an INPUT, not a <button>),
 *     - app/ui.js is an ES module, so window.UI does NOT exist there and the
 *       DOM path below is the live one (the window.UI.rfb branch only serves
 *       legacy <= 1.3 classic-script builds). ui.js reads the input value at
 *   submit time, so fill -> click is the exact manual-typing equivalent.
 *
 * RETRY CONTRACT (F13-3: "retry 5x500ms; purge")
 *   Each accepted postMessage gets a FRESH 5x500ms submit budget (the opener
 *   repeats the handoff up to 6x500ms, so a dialog that appears seconds into
 *   the RFB handshake is still filled); once a budget is exhausted the value
 *   is purged and only a NEW accepted message re-arms it. Nothing is retained
 *   after a handoff completes or the idle cap stops the timer.
 *
 * SECURITY CONTRACT (launch-gates F11/F13 enforce it)
 *   - the password never enters a URL, query string, hash or storage key here;
 *   - this file contains NO console/log/alert/document.title call, so the value
 *     can never be echoed to a log, an artifact or the browser console;
 *   - the opener handle is dropped after the one successful handoff, so the
 *     dashboard tab cannot be scripted back through this window.
 *   - no credentials are stored here: the dashboard owns the remembered copy,
 *     this shim is a transient one-way pipe.
 */
(function () {
    'use strict';

    var ALLOWED = [];
    try {
        var meta = document.querySelector('meta[name="ghrdp-cred-origin"]');
        if (meta && meta.content) {
            var parts = String(meta.content).split(/\s+/);
            for (var i = 0; i < parts.length; i++) {
                if (parts[i]) { ALLOWED.push(parts[i]); }
            }
        }
    } catch (e) { ALLOWED = []; }

    var applied = false;
    var pending = null;      // transient; purged as soon as it is handed over

    function originAllowed(origin) {
        for (var i = 0; i < ALLOWED.length; i++) {
            if (origin === ALLOWED[i]) { return true; }
        }
        return false;
    }

    function accept(ev) {
        if (!ev || !ev.data || ev.data.type !== 'ghrdp-vnc-pass') { return false; }
        if (typeof ev.data.pass !== 'string') { return false; }
        if (ev.data.pass.length === 0 || ev.data.pass.length > 1024) { return false; }
        if (ev.source !== window.opener) { return false; }
        return originAllowed(ev.origin);
    }

    function submit(pass) {
        if (applied) { return true; }
        var rfb = window.UI && window.UI.rfb;   // legacy <= 1.3 classic scripts only
        if (rfb && typeof rfb.sendCredentials === 'function') {
            try { rfb.sendCredentials({ password: pass }); applied = true; return true; } catch (e) { }
        }
        var input = document.getElementById('noVNC_password_input');
        var dlg = document.getElementById('noVNC_credentials_dlg');        // noVNC v1.7.0 (pinned)
        if (!dlg) { dlg = document.getElementById('noVNC_credentials_dialog'); }  // legacy <= 1.3
        if (!input || !dlg) { return false; }
        var open = false;
        try { open = dlg.classList.contains('noVNC_open'); } catch (e) { open = false; }
        if (!open) { return false; }   // dialog exists in the DOM from load; submit only when open
        try {
            input.value = pass;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            var btn = dlg.querySelector('#noVNC_credentials_button')       // <input type=submit>, v1.7.0
                || dlg.querySelector('.noVNC_primary, button[type="button"], button');  // legacy
            if (btn) { btn.click(); }
            applied = true;
            return true;
        } catch (e) { return false; }
    }

    function purgeValue() {
        pending = null;   // the transient value is gone; opener stays for its repeats
    }

    function purge() {
        pending = null;
        try { if (window.opener) { window.opener = null; } } catch (e) { }
    }

    var RETRY_CAP = 5;
    var IDLE_CAP = 40;
    var tries = 0;
    var idle = 0;
    var timer = null;

    function stop() {
        if (timer !== null) { clearInterval(timer); timer = null; }
    }

    function arm() {
        if (timer !== null) { return; }
        timer = setInterval(function () {
            if (applied) { purge(); stop(); return; }
            if (!pending) {
                idle++;
                if (idle > IDLE_CAP) { purge(); stop(); }   // gave up: value AND opener go
                return;
            }
            tries++;
            if (tries > RETRY_CAP) { purgeValue(); return; }  // value gone; a new handoff re-arms
            if (submit(pending)) { purge(); stop(); }
        }, 500);
    }

    window.addEventListener('message', function (ev) {
        if (!accept(ev)) { return; }
        pending = String(ev.data.pass);
        tries = 0;   // fresh 5x500ms budget per accepted handoff
        idle = 0;
        arm();
        if (submit(pending)) { purge(); stop(); }
    }, false);

    arm();   // start the idle watcher immediately (never retains a value)
})();
