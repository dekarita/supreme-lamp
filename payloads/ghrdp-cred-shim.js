/* ghrdp-cred-shim.js  [F11-2 §2]  VNC password handoff shim (client-side only).
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
 *   It then auto-submits the noVNC Credentials dialog (RFB.sendCredentials
 *   when the API is present, otherwise fills #noVNC_password_input and clicks
 *   the dialog's primary button) and PURGES the local variable immediately.
 *
 * SECURITY CONTRACT (launch-gates F11 enforce it)
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
    var tries = 0;

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
        var rfb = window.UI && window.UI.rfb;
        if (rfb && typeof rfb.sendCredentials === 'function') {
            try { rfb.sendCredentials({ password: pass }); applied = true; return true; } catch (e) { }
        }
        var input = document.getElementById('noVNC_password_input');
        if (!input) { return false; }
        try {
            input.value = pass;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            var dlg = document.getElementById('noVNC_credentials_dialog');
            var btn = dlg && dlg.querySelector('.noVNC_primary, .noVNC_ok_button, button.noVNC_primary, button[type="button"], button');
            if (btn) { btn.click(); }
            applied = true;
            return true;
        } catch (e) { return false; }
    }

    function purge() {
        pending = null;
        try { if (window.opener) { window.opener = null; } } catch (e) { }
    }

    window.addEventListener('message', function (ev) {
        if (!accept(ev)) { return; }
        pending = String(ev.data.pass);
        if (submit(pending)) { purge(); }
    }, false);

    // The credentials dialog only exists once the RFB object reaches
    // 'credentialsrequired'; if the handoff lands first, retry briefly (5s cap).
    var timer = setInterval(function () {
        tries++;
        if (applied) { purge(); clearInterval(timer); return; }
        if (tries > 10) { purge(); clearInterval(timer); return; }
        if (pending && submit(pending)) { purge(); clearInterval(timer); }
    }, 500);
})();
