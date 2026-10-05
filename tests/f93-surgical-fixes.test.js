// [F93] Surgical-fix pins: add-site per-field reasons, launcher auto-start on
// logon detection, and the reconnect ladder. Grep-level proof over the shipped
// sources, matching the F84/F87/F91 house style (no PowerShell runtime here).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SERVER = readFileSync("payloads/ghrdp-server.ps1", "utf8");
const HOOK = readFileSync("src/hooks/useDashboardPolling.ts", "utf8");
const MODAL = readFileSync("src/components/search/AddSiteQuick.tsx", "utf8");
const BANNER = readFileSync("src/components/domain/LogonGateBanner.tsx", "utf8");
const SHELL = readFileSync("src/components/layout/AppShell.tsx", "utf8");
const LABAPI = readFileSync("src/api/lab/index.ts", "utf8");
const EN = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
const SI = JSON.parse(readFileSync("src/i18n/si.json", "utf8"));

test("F93-1 PROBE: GET + 10 redirects + 10s + 2xx/3xx is reachable", () => {
  assert.ok(SERVER.includes("$f78ProbeReq.Method = 'GET'"), "probe is not GET (HEAD is what CDNs refuse)");
  assert.ok(SERVER.includes("$f78ProbeReq.Timeout = 10000"), "probe is not 10s-bounded");
  assert.ok(SERVER.includes("$f78ProbeReq.MaximumAutomaticRedirections = 10"), "redirect cap is not 10");
  assert.ok(SERVER.includes("$f78ProbeStatus -lt 400"), "3xx is not accepted as reachable");
});

test("F93-1 REASONS: the six named reasons exist and errors.url carries one", () => {
  for (const r of ["cloudflare-challenge", "dns-nxdomain", "ssl-cert-invalid", "timeout-10s", "http-5xx", "redirect-loop"]) {
    assert.ok(SERVER.includes("'" + r + "'"), "missing concrete reason " + r);
  }
  assert.ok(SERVER.includes("function Get-F93ProbeReason"), "classifier missing");
  assert.ok(SERVER.includes("if ($f78ProbeReason) { $f78FieldErrors['url'] = $f78ProbeReason }"), "errors.url is not the concrete reason");
  assert.ok(SERVER.includes("details = [ordered]@{ reason = [string]$f78ProbeReason"), "details.reason missing");
  // The F84 pin stays as the fallback (superseded, never deleted).
  assert.ok(SERVER.includes("$f78FieldErrors['url'] = 'addSite.probeFailed'"), "F84 fallback key deleted");
});

test("F93-1 CLIENT: per-field errors win, reasons render as sentences, auth is not 'validation'", () => {
  assert.ok(LABAPI.includes("fieldErrors.url || fieldErrors.name"), "per-field key precedence lost");
  assert.ok(LABAPI.includes('offline("AUTH_REQUIRED", "addSite.authMissing")'), "401 silently maps to generic validation");
  assert.ok(MODAL.includes("outcome.fieldErrors"), "modal does not read fieldErrors");
  assert.ok(MODAL.includes("setNameError(fe.name ? String(fe.name) : null)"), "name field error not per-field");
  assert.ok(MODAL.includes("setUrlError(fe.url ? String(fe.url) : null)"), "url field error not per-field");
  assert.ok(MODAL.includes("isProbeReason(v) ? reasonText("), "reason codes are not rendered as sentences");
  for (const k of ["cloudflareChallenge", "dnsNxdomain", "sslCertInvalid", "timeout10s", "http5xx", "redirectLoop", "noResponse", "httpStatus", "other"]) {
    assert.equal(typeof EN.addSite.reason[k], "string", "en addSite.reason." + k + " missing");
    assert.equal(typeof SI.addSite.reason[k], "string", "si addSite.reason." + k + " missing");
  }
});

test("F93-2 LAUNCHER: logon watcher polls every 10s for type-10 4624 and starts the task", () => {
  assert.ok(SERVER.includes("function Start-F93LauncherLogonWatch"), "watcher missing");
  assert.ok(SERVER.includes("Start-Sleep -Seconds 10"), "watcher is not 10s cadence");
  assert.ok(SERVER.includes("LogName = 'Security'; Id = 4624"), "watcher does not read 4624");
  assert.ok(SERVER.includes("if ($lt -eq '10') { $fired = $true; break }"), "watcher does not require LogonType 10");
  assert.ok(SERVER.includes("/SC ONLOGON /TN GHRDP-Launcher"), "watcher cannot register the task");
  assert.ok(SERVER.includes("Start-ScheduledTask -TaskName 'GHRDP-Launcher'"), "watcher does not start the task");
  assert.ok(SERVER.includes("autoStarted = $false; autoStartedAt = ''"), "health lacks autoStarted");
  assert.ok(SERVER.includes("if ($f93Auto -and $f93Auto.autoStarted -eq $true)"), "autoStarted is never read back");
});

test("F93-2 BANNER: every route, self-hiding, button opens the validated WEB DESKTOP url", () => {
  assert.ok(SHELL.includes("<LogonGateBanner />"), "banner not mounted in the shell");
  assert.ok(BANNER.includes('authLast.result === "success"'), "banner does not hide on success");
  assert.ok(BANNER.includes("validWebdeskUrl(s.webdeskUrl)"), "banner does not use the validated webdesk url");
  assert.ok(BANNER.includes('window.open(webdeskUrl, "_blank", "noopener")'), "banner button does not open the webdesk");
  assert.ok(MODAL.includes("/api/launcher/health"), "modal does not read launcher health");
  assert.ok(MODAL.includes('if (alive && j && j.serviceRunning === false) setLauncherOffline(true)'), "modal launcher hint missing");
  for (const k of ["title", "message", "button", "noUrl"]) {
    assert.equal(typeof EN.logonGate[k], "string", "en logonGate." + k + " missing");
    assert.equal(typeof SI.logonGate[k], "string", "si logonGate." + k + " missing");
  }
});

test("F93-3 RECONNECT: 5s ping + linear ladder + lost only after the ladder", () => {
  assert.ok(HOOK.includes("window.setInterval(pollPing, 5000)"), "ping cadence is not 5s");
  assert.ok(HOOK.includes("const RECONNECT_LADDER = [1000, 3000, 10000, 30000];"), "ladder missing");
  assert.ok(HOOK.includes("if (progressFail < RECONNECT_LADDER.length)"), "ladder is not walked before loss");
  assert.ok(HOOK.includes("setProgress(null);"), "the connection-lost signal is never set");
  assert.ok(HOOK.includes("const step = RECONNECT_LADDER[Math.min(wsAttempt, RECONNECT_LADDER.length - 1)]"), "ws reconnect has no ladder");
  assert.ok(HOOK.includes("if (progressTimer) window.clearTimeout(progressTimer)"), "progress timer leaks on unmount");
  assert.ok(HOOK.includes("window.setTimeout(progressLoop, 3000)"), "healthy progress cadence changed");
  // The real starvation source behind the dropped polls: the 11-site fanout.
  assert.ok(SERVER.includes("$script:F92SelftestCache"), "f92 selftest fanout is not memoised");
  assert.ok(SERVER.includes("TotalSeconds) -lt 20"), "f92 memo window missing");
});
