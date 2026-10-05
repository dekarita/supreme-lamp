// [F41] Native-status view models - faithful ports of the F38 ui.html render
// logic (chips, listener marks, conn log, auth discriminator, logon row,
// recovery correlator, webdesk guidance, launch gating). PURE: no DOM, no
// fetch. React components consume these and render.
import { parseTsUtc, FQDN_RE, CGNAT_RE, USER_RE } from "../format";
import { asList } from "./telescope";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const REASON_TEXT: Record<string, string> = {
  "fqdn-not-tsnet":
    "FQDN not *.ts.net - if MagicDNS is off, enable it: https://login.tailscale.com/admin/dns (workflow halts until enabled); VPS: provision per docs/MIGRATION.md sec 1.7",
  "cert-not-bound": "LE cert not bound on RDP-Tcp - run Enable-RdpTlsCertificate.ps1 on host",
  "nla-off": "NLA off on host - set UserAuthentication=1 on RDP-Tcp",
  "no-cmdkey-entry": "no cmdkey entry for TERMSRV/<fqdn> on this PC - run the cmdkey line once (current user)",
  "runner-dns-broken": "Runner DNS broken",
};

export const MAGIC_DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";
export const SECRETS_URL = "https://github.com/dekarita/supreme-lamp/settings/secrets/actions";
export const ACTIONS_URL = "https://github.com/dekarita/supreme-lamp/actions";

// [F28 §4] credsspVerdict: the SINGLE source both the CREDSSP row and the RDP
// LISTENER credssp mark render. Live probe first, then the F21 config stamp
// with its historic semantics: absent = pre-F21 back-compat (never a fail),
// 'ok-with-cipher-warn' [F23] = determinants verified.
export function credsspVerdict(rl: Any): { ok: boolean; label: string; why: string; source: string } {
  const live = rl && rl.credsspLive ? String(rl.credsspLive) : "";
  const liveWhy = rl && rl.credsspLiveWhy ? String(rl.credsspLiveWhy) : "";
  const stamp = rl && rl.credsspStatus !== undefined && rl.credsspStatus !== null ? String(rl.credsspStatus) : "";
  if (live === "ok") return { ok: true, label: "credssp (live probe)", why: "", source: "live" };
  if (live === "warn")
    return { ok: false, label: "credssp (live probe: " + (liveWhy || "warn") + ")", why: liveWhy || "live probe warn", source: "live" };
  const stampOk = !stamp || stamp === "ok" || (rl && rl.credsspStatus === "ok-with-cipher-warn");
  if (stampOk) return { ok: true, label: "credssp" + (stamp ? " (stamp: " + stamp + ")" : ""), why: "", source: "stamp" };
  return { ok: false, label: "credssp (stamp: " + stamp + ")", why: (rl && rl.credsspWhy) || stamp, source: "stamp" };
}

// [F17 §2] RDP LISTENER marks: one check/x per probed field + the exact fix.
export interface ListenerMark {
  ok: boolean;
  label: string;
  fix?: string;
}
export function rdpListenerMarks(rl: Any): ListenerMark[] {
  if (!rl || typeof rl !== "object") return [];
  const marks: ListenerMark[] = [];
  marks.push({
    ok: rl.listening === true,
    label: "listening",
    fix: rl.termServiceOk === false
      ? "TermService=" + (rl.termService || "?") + " - fix: Start-Service TermService"
      : "fix: nothing accepts 127.0.0.1:3389 - re-run \"Enable RDP + harden + firewall\"",
  });
  marks.push({ ok: rl.termServiceOk === true, label: "termService", fix: "fix: Start-Service TermService (StartupType Automatic)" });
  marks.push({
    ok: rl.fwRule === true,
    label: "fw " + (rl.fwScope || "100.64.0.0/10"),
    fix: "fix: rule GHRDP-RDP must be enabled, ALL profiles, RemoteAddress 100.64.0.0/10",
  });
  marks.push({ ok: rl.certOk === true, label: "cert", fix: "fix: re-run \"Bind tailnet LE cert\" (tailscale cert <fqdn>)" + (rl.certWhy ? " - " + rl.certWhy : "") });
  marks.push({ ok: rl.nla === true, label: "nla", fix: "fix: set UserAuthentication=1 on RDP-Tcp (NLA on)" });
  const csv = credsspVerdict(rl);
  marks.push({
    ok: csv.ok,
    label: csv.label,
    fix: "fix: F21 CredSSP/NLA verification failed - " + csv.why + " (check CredSSP policy, cert trust, cipher suites; see CONNECTION DIAGNOSTICS)",
  });
  return marks;
}

export function listenerOk(rl: Any): boolean {
  if (!rl || typeof rl !== "object") return false;
  const csv = credsspVerdict(rl);
  return !!(rl.listening === true && rl.fwRule === true && rl.certOk === true && rl.nla === true && csv.ok);
}

// CredSSP chip (nrCredssp) - live probe first, stamp fallback; 'not reported'
// is NOT a failure (F24 §3).
export function credsspChip(rl: Any): { text: string; tone: "ok" | "warn" | "bad" | "neutral" } {
  const csLive = rl && rl.credsspLive ? String(rl.credsspLive) : "";
  const csLiveWhy = rl && rl.credsspLiveWhy ? String(rl.credsspLiveWhy) : "";
  const cs = rl && rl.credsspStatus ? String(rl.credsspStatus) : "";
  const stampTxt = " (stamp: " + (cs || "none") + ")";
  if (csLive === "ok") return { text: "OK (live probe)" + stampTxt, tone: "ok" };
  if (csLive === "warn") return { text: "WARN (live probe: " + (csLiveWhy || "warn") + ")" + stampTxt, tone: "warn" };
  const csGood = cs === "ok" || cs === "ok-with-cipher-warn";
  if (csGood) return { text: cs === "ok" ? "OK" : "OK (cipher probe warn)", tone: "ok" };
  if (!cs) return { text: "not reported yet (F21 step: CredSSP/NLA handshake verification)", tone: "warn" };
  return { text: "FAIL (" + cs + ")", tone: "bad" };
}

// [F30 §3] SERVER CONN LOG render (state + newest 3 lines + TLS stamp + bind line).
export function srvConnLogModel(s: Any): {
  state: string;
  stateTone: "ok" | "warn" | "neutral";
  lines: string;
  tls: string;
  tlsTone: "ok" | "warn" | "bad" | "neutral";
  bind: string;
  bindTone: "ok" | "warn" | "bad" | "neutral";
} {
  const rl = (s && s.rdpListener) || {};
  const cl = rl && rl.connLog ? rl.connLog : s && s.connLog ? s.connLog : null;
  const col = rl && rl.connLogCollector ? rl.connLogCollector : s && s.connLogCollector ? s.connLogCollector : null;
  const out = {
    state: "",
    stateTone: "neutral" as "ok" | "warn" | "neutral",
    lines: "",
    tls: "",
    tlsTone: "neutral" as "ok" | "warn" | "bad" | "neutral",
    bind: "",
    bindTone: "neutral" as "ok" | "warn" | "bad" | "neutral",
  };
  if (!cl) {
    out.state =
      "collector not reported yet - the server 30s tick reads Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational + Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational";
    out.stateTone = "warn";
    return out;
  }
  const items = cl.items && cl.items.length ? cl.items : asList(cl.newest);
  const newest = items.slice(0, 3);
  const alive = !!(col && col.alive === true);
  const probe = col && col.probeError ? " probeError=" + col.probeError : "";
  const cnt = typeof cl.count === "number" ? cl.count : items.length;
  out.state = alive
    ? "collector alive (30s) - " + cnt + " event(s) in window; newest 3 below" + probe
    : "collector STALE (no sample within 90s) - reason codes are NOT live" + probe;
  out.stateTone = alive ? "ok" : "warn";
  if (!newest.length) {
    out.lines = "no events yet - nothing reached the RDP stack";
  } else {
    out.lines = newest
      .map((e: Any) => {
        const ts = String(e.timeUtc || "").replace("T", " ").replace(/\..*/, "");
        return ts + " #" + e.id + " " + e.provider + " reason=" + e.reason + (e.level ? " level=" + e.level : "") + (e.desc ? " - " + e.desc : "");
      })
      .join("\n");
  }
  // [F37 §4] bind drift + key ACL SIDs + Schannel tail from the runner 60s tick.
  const tel = rl && rl.telescopeLive ? rl.telescopeLive : rl && rl.telescope ? rl.telescope : s && s.telescope ? s.telescope : null;
  const tc = s && s.telescopeCollector ? s.telescopeCollector : null;
  if (!tel) {
    out.bind = "telescope: not reported yet (runner 60s tick) - bind drift not proven";
    out.bindTone = "warn";
  } else {
    const bt = String(tel.boundThumb || "");
    const st2 = String(tel.servedThumb || "");
    const drift = !!tel.bindDrift || (bt && st2 && bt !== st2);
    const aclMethod = String(tel.aclReadMethod || "");
    const sids = tel.aclSids && tel.aclSids.length ? tel.aclSids.join(" ") : "not read";
    let aclTxt = "";
    if (aclMethod === "none") aclTxt = aclMethod + " NO-READER";
    else if (tel.aclRead === true) aclTxt = "yes(" + (aclMethod || "get-acl") + ")";
    else aclTxt = aclMethod || "unknown";
    let aclMod = tel.aclModule ? " aclModule=" + String(tel.aclModule).slice(0, 80) : "";
    if (aclMod && /security-unavailable/.test(aclMod)) {
      const m = String(tel.aclModule);
      const mm = m.match(/security-unavailable:<TypeData error in ([^>]*)>/);
      aclMod = " aclModule=security-unavailable:" + (mm ? mm[1] : m.slice(0, 60));
    }
    const sch = tel.schannelIds && tel.schannelIds.length ? tel.schannelIds.join(",") : "none";
    const ekuBad = tel.eku && tel.eku.length ? !asList(tel.eku).some((x: Any) => String(x).indexOf("Server Auth") >= 0 || String(x).indexOf("1.3.6.1.5.5.7.3.1") >= 0) : tel.hasServerAuth === false;
    const ekuTxt = ekuBad ? " EKU=NO-ServerAuth eku=" + (tel.eku && tel.eku.length ? tel.eku.join(",") : "none") + " san=" + (tel.san && tel.san.length ? tel.san.join(",") : "none") : "";
    const keyHits = tel.keyDirHits && tel.keyDirHits.length ? "; hits=" + tel.keyDirHits.slice(0, 3).join(",") : "";
    const keyKind = tel.containerKind ? " kind=" + tel.containerKind : "";
    const keyDir = tel.keyDirSample && tel.keyDirSample.length ? " dir=" + String(tel.keyDirSample[0]).slice(0, 80) : "";
    const keySrc = tel.keyFilePathSource ? " src=" + String(tel.keyFilePathSource) : "";
    const keyBad = tel.keyFileMissing === true || (!tel.keyFilePathSource && (tel.containerKind === "cert" || tel.bindDrift === true));
    const keyTxt = keyBad || keySrc ? (keyBad ? " keyFile=NOT-FOUND" : " keyFile=ok") + keyKind + keySrc + (keyBad ? "(" + String(tel.containerPath || tel.container || "?") + keyHits + keyDir + ")" : "") : "";
    const fatal = tel.fatalStages && tel.fatalStages.length ? " fatalStages=" + tel.fatalStages.join(",") : "";
    const reds = tel.redStages && tel.redStages.length ? " redStages=" + tel.redStages.join(",") : "";
    const dErr = tel.deriveError ? " deriveError=" + String(tel.deriveError).slice(0, 120) : "";
    const kErr = tel.keyTypedError ? " keyTypedError=" + String(tel.keyTypedError).slice(0, 120) : "";
    const ldr = tel.typesLoader ? " loader=" + String(tel.typesLoader).slice(0, 60) : "";
    const lWhy = tel.listenerWhy && !tel.aclOk ? " listenerWhy=" + String(tel.listenerWhy).slice(0, 160) : "";
    const warn = tc && tc.probeWarn ? " | evidence: " + String(tc.probeWarn).slice(0, 160) : "";
    out.bind =
      "telescope[" + String(tel.src || "live") + "] bound=" + (bt || "(none)") + " served=" + (st2 || "(none)") +
      " " + (drift ? "DRIFT" : "match") + " aclRead=" + aclTxt + " aclSids=" + sids + aclMod +
      " schannel=[" + sch + "]" + (tel.schannelWhy ? " " + tel.schannelWhy : "") + ekuTxt + keyTxt + fatal + reds + dErr + kErr + ldr + lWhy +
      " deathPoint=" + String(tel.deathPoint || "none") + (tc ? " (tick " + (tc.alive === true ? "alive" : "STALE") + ")" : "") + warn;
    const aclBlind = aclMethod === "none" && tel.aclRead !== true && tel.deathPoint && tel.deathPoint !== "none";
    out.bindTone = drift || ekuBad || keyBad || aclBlind || (tel.fatalStages && tel.fatalStages.length) || tel.deriveError ? "bad" : tel.deathPoint && tel.deathPoint !== "none" ? "warn" : "ok";
  }
  const tn = rl && rl.tlsNorm ? rl.tlsNorm : null;
  if (!tn) {
    out.tls = "server TLS/cipher stamp: not reported yet (main.yml step TLS/cipher normalization (F30))";
    out.tlsTone = "warn";
  } else {
    const bad: string[] = [];
    if (tn.orderOk !== true) bad.push("cipher order not verified");
    if (Number(tn.tls12Sides) < 2) bad.push("TLS 1.2 not enabled on both sides");
    if (Number(tn.securityLayer) !== 2 || Number(tn.minEncryptionLevel) < 3) bad.push("RDP security layer/encryption below policy");
    out.tls =
      "server TLS: ordered=" + (tn.orderOk === true ? "yes" : "NO") + " tls12Sides=" + tn.tls12Sides + " tls13Sides=" + tn.tls13Sides +
      " securityLayer=" + tn.securityLayer + " minEncryptionLevel=" + tn.minEncryptionLevel + (bad.length ? " - " + bad.join("; ") : "") +
      (typeof tn.ageSec === "number" ? " (stamp age " + tn.ageSec + "s)" : "");
    out.tlsTone = bad.length ? "warn" : "ok";
  }
  return out;
}

// [F28 §1] logonRowText - the LAST RDP LOGON row, rendered from rdpListener.authLast.
export function logonRowText(authLast: Any, collector: Any, _nowMs?: number): {
  text: string;
  red: boolean;
  dead?: boolean;
  result?: string;
  eventTs?: string;
  scanTs?: string;
  sub?: string;
  /** [F95 §3.1 / R1] the accepted LogonType the verdict came from, "" if none. */
  logonType?: string;
} {
  const c = collector || {};
  const up = typeof c.uptimeSec === "number" ? c.uptimeSec : null;
  const dead = c.alive === false || (up !== null && up > 90 && !authLast);
  if (!authLast) {
    if (dead) return { text: "logon collector not running (server up " + (up === null ? "?" : up) + "s, no scan yet - the 30s server-side tick never stamped)", red: true, dead: true };
    return { text: "scanning... (server up " + (up === null ? "?" : up) + "s, first scan pending)", red: false };
  }
  const pe = authLast.probeError ? " | collector=" + authLast.probeError : "";
  if (!authLast.scanTs) return { text: "logon collector not running (the last scan carried no scanTs)", red: true, dead: true };
  const scanned = "scanned " + authLast.scanTs;
  const sub = authLast.sub ? " sub=" + authLast.sub + (authLast.subMeaning ? " (" + authLast.subMeaning + ")" : "") : "";
  // [F95 §3.1 / R1] name WHICH logon type the verdict came from, so
  // "success" is not a bare word: an AutoAdminLogon desktop (type 2) and a
  // real inbound RDP client (type 10) are different facts.
  const lt = String(authLast.logonType || "").trim();
  const ltNote = lt ? " [LogonType " + lt + (authLast.logonKind ? " " + authLast.logonKind : "") + "]" : "";
  if (authLast.result === "success")
    return { text: "success at " + (authLast.eventTs || "?") + ltNote + " - " + scanned + pe, red: false, result: "success", eventTs: authLast.eventTs || "", scanTs: authLast.scanTs, sub: authLast.sub || "", logonType: lt };
  if (authLast.result === "failed")
    return { text: "failed" + sub + " at " + (authLast.eventTs || "?") + " - " + scanned + pe, red: true, result: "failed", eventTs: authLast.eventTs || "", scanTs: authLast.scanTs, sub: authLast.sub || "", logonType: lt };
  return {
    // [F95 §3.1 / R1] was "(no type-10 4624 and no 4625 since ...)". That text
    // was the operator's verbatim banner line and it was TRUE about the filter
    // and WRONG about the machine: the collector had never been allowed to
    // count the autologon (type 2) it was standing on. The row now names all
    // three accepted types so a future over-strict filter is visible here.
    text: "none yet - " + scanned + " (no interactive 4624 [LogonType 2/10/11] and no 4625 since " + (authLast.windowStart || "the scan window start") + ")" + pe,
    red: false,
    result: "none",
    eventTs: "",
    scanTs: authLast.scanTs,
    sub: "",
    logonType: "",
  };
}

// [F28 §2] recoveryDecision: PURE correlator - recovery offered ONLY when the
// host refused the password (4625 0xC000006A) within 120s of the last
// mstsc-started beacon.
export function recoveryDecision(authLast: Any, chain: Any, _nowMs?: number): {
  show: boolean;
  why: string;
  dtSec?: number;
  sub?: string;
  beaconTs?: string;
} {
  if (!authLast || String(authLast.result) !== "failed") return { show: false, why: "no-failed-logon" };
  if (String(authLast.sub || "").toUpperCase() !== "0XC000006A") return { show: false, why: "sub-not-wrong-password", sub: String(authLast.sub || "") };
  let beacon: Any = null;
  (chain || []).forEach((e: Any) => {
    if (e && /^mstsc-started/.test(String(e.details || ""))) beacon = e;
  });
  if (!beacon) return { show: false, why: "no-mstsc-started-beacon" };
  const beaconMs = Date.parse(beacon.ts);
  const logonMs = Date.parse(authLast.eventTs || authLast.scanTs || "");
  if (!isFinite(beaconMs) || !isFinite(logonMs)) return { show: false, why: "timestamp-unparsable" };
  const dtSec = (logonMs - beaconMs) / 1000;
  if (dtSec < -120) return { show: false, why: "failure-predates-the-launch", dtSec: Math.round(dtSec) };
  if (dtSec > 120) return { show: false, why: "failure-more-than-120s-after-the-launch", dtSec: Math.round(dtSec) };
  return { show: true, why: "password-rejected-by-host", dtSec: Math.round(dtSec), beaconTs: String(beacon.ts || "") };
}

// [F24 §3] AUTH-REJECT DISCRIMINATOR branches.
export interface AuthDiscriminator {
  verdict: string;
  verdictTone: "ok" | "warn" | "bad" | "neutral";
  detail: string;
  showCmds: boolean;
  showCmdKeyDel: boolean;
  showPassCopy: boolean;
  showCapi2: boolean;
  showSystem: boolean;
  cmdKeyDel: string;
  aeText: string;
  csText: string;
}
export function authDiscriminator(rl: Any, s: Any): AuthDiscriminator {
  rl = rl || null;
  s = s || {};
  const cv = rl && typeof rl.credValid === "boolean" ? rl.credValid : null;
  const cvErr = rl && rl.credValidProbeError ? String(rl.credValidProbeError) : "";
  const ae = rl && rl.authEvents ? rl.authEvents : null;
  const codes: Any[] = [];
  if (ae && ae.codes) {
    const rawCodes = ae.codes;
    if (rawCodes && typeof rawCodes.length === "number") codes.push(...rawCodes);
    else if (typeof rawCodes === "object") codes.push(rawCodes);
  }
  const codeUp = codes.map((c) => (c && c.code ? String(c.code).toUpperCase() : "")).filter(Boolean);
  const stale = codeUp.indexOf("0XC000006A") >= 0 || codeUp.indexOf("0XC000006D") >= 0;
  const n4624 = ae && ae.count4624 != null ? Number(ae.count4624) : null;
  const n4625 = ae && ae.count4625 != null ? Number(ae.count4625) : null;
  const aeText = ae
    ? "runner Security log (" + (ae.windowSec ? Math.round(Number(ae.windowSec) / 60) : 0) + " min window): 4624=" + n4624 + " 4625=" + n4625 +
      (ae.verdict ? " verdict=" + ae.verdict : "") + (codeUp.length ? " codes=" + codeUp.join(",") : "") + (ae.probeError ? " probeError=" + ae.probeError : "")
    : "runner Security-log counts: not collected yet (the F24 §2 collector ticks every 60s during keep-alive)";
  const fqdn = String((s && s.fqdn) || (rl && rl.fqdn) || "");
  const cmdKeyDel = "cmdkey /delete:TERMSRV/" + (fqdn || "<fqdn>");
  const csSt = rl && rl.credsspStatus ? String(rl.credsspStatus) : "";
  const csWhy = rl && rl.credsspWhy ? String(rl.credsspWhy) : "";
  const csText =
    csSt === "ok"
      ? "CredSSP: OK - NLA=1, cert trusted, policy strict"
      : csSt === "ok-with-cipher-warn"
        ? "CredSSP: OK (cipher probe warn) - " + (csWhy || "cipher probe could not enumerate; Windows defaults include AES-256-GCM")
        : csSt
          ? "CredSSP: FAIL (" + csSt + ") - " + (csWhy || "no detail") + " - see the failed F21 step \"CredSSP/NLA handshake verification\""
          : "CredSSP: not reported yet - F21 step: CredSSP/NLA handshake verification";
  const base = { cmdKeyDel, aeText, csText };
  if (cv === false && cvErr)
    return {
      ...base,
      verdict: "PROBE FAILED - the server-side credential proof could not run (" + cvErr + ") - re-dispatch",
      verdictTone: "warn",
      detail: "This is NOT a credential verdict: ValidateCredentials could not execute on the runner (F24 §1 step). Re-dispatch and read that step. " + aeText + ". " + csText,
      showCmds: false, showCmdKeyDel: false, showPassCopy: false, showCapi2: false, showSystem: false,
    };
  if (cv === false)
    return {
      ...base,
      verdict: "SERVER credential bug - re-dispatch",
      verdictTone: "bad",
      detail: "rdpListener.credValid=false: the dispatch password FAILED validation against the runner\u2019s own local SAM, so the password on the KEYS row is already dead and no client-side action can fix it. Re-dispatch - a fresh user+password pair is generated every run. " + aeText + ". " + csText,
      showCmds: false, showCmdKeyDel: false, showPassCopy: false, showCapi2: false, showSystem: false,
    };
  if (cv === true && ae && ae.last4624At && !ae.probeError && (!ae.last4625At || Date.parse(ae.last4624At) > Date.parse(ae.last4625At)))
    return {
      ...base,
      verdict: "RDP authentication succeeded (4624, logon type 10)",
      verdictTone: "ok",
      detail: "Latest remote-interactive success: " + ae.last4624At + ". Older failures remain in the evidence window. Fullscreen and usage still need client confirmation. " + aeText + ". " + csText,
      showCmds: false, showCmdKeyDel: false, showPassCopy: false, showCapi2: false, showSystem: false,
    };
  if (cv === true && stale)
    return {
      ...base,
      verdict: "YOUR stored password is stale: use WINDOWS AUTO-LOGIN; copy CURRENT password from KEYS only for fallback",
      verdictTone: "warn",
      detail: "rdpListener.credValid=true (the server credential is VALID) BUT the runner logged failed logons 4625 with " + codeUp.join(",") + " (wrong password / bad user or password): the credential Windows has STORED for this target on YOUR PC does not match this run. Click WINDOWS AUTO-LOGIN: the F27 ticket path overwrites the poisoned entry. Only if fallback-cmdkey is reported: copy CURRENT password from KEYS and paste the copied password EXACTLY at the Windows prompt. The manual reset below is optional; no tooling deletes credentials. " + aeText + ". " + csText,
      showCmds: true, showCmdKeyDel: true, showPassCopy: true, showCapi2: false, showSystem: false,
    };
  if (cv === true)
    return {
      ...base,
      verdict: "TLS-layer suspect (no 4625 logged on the runner)",
      verdictTone: "warn",
      detail: "rdpListener.credValid=true and the runner logged NO failed logon (4625) in the window above, so the reject is NOT a credential mismatch - it is the TLS/CredSSP layer (client certificate chain, Schannel, CAPI2). Export the client logs with the two copy-lines below and paste them into this session: the cause is mapped from the logged event, never guessed. " + aeText + ". " + csText,
      showCmds: true, showCmdKeyDel: false, showPassCopy: false, showCapi2: true, showSystem: true,
    };
  return {
    ...base,
    verdict: "not reported yet - the F24 step \"Server-side credential proof\" has not run for this target",
    verdictTone: "warn",
    detail: "No credValid verdict in /api/native-status yet (a pre-F24 run, or the step has not executed). " + aeText + ". " + csText,
    showCmds: false, showCmdKeyDel: false, showPassCopy: false, showCapi2: false, showSystem: false,
  };
}

// [F19 §1] client-DNS probe decision core (pure; node-tested in v1 too).
export function clientDnsCore(fqdn: string, ip: string, scheme: string, aOk: boolean, bOk: boolean): { verdict: string; why: string } {
  if (scheme !== "http:") return { verdict: "skipped", why: "probe skipped: this page is not plain http, so the browser blocks the http probes (mixed content)" };
  if (!FQDN_RE.test(fqdn || "")) return { verdict: "unknown", why: "client DNS probe pending: no MagicDNS FQDN reported by the server yet" };
  if (!CGNAT_RE.test(ip || "")) return { verdict: "unknown", why: "client DNS probe pending: no runner tailnet IP reported by the server yet" };
  if (bOk) return { verdict: "ok", why: "client DNS ok - the MagicDNS name resolves on THIS PC" };
  if (aOk) return { verdict: "client-dns-off", why: "YOUR PC's Tailscale DNS is off (name not resolvable, IP reachable)" };
  return { verdict: "unreachable", why: "neither the tailnet IP nor the MagicDNS name answered from THIS PC - check that Tailscale is running and connected here" };
}

// [F27/F28] protocol URL builders - server|user|ip are identity, never
// credentials; a ticket (t) is the ONLY secret a URL may carry.
export function ghrdpRdpUrl(fqdn: string, user: string, ip?: string): string {
  const u = "ghrdp://rdp?server=" + encodeURIComponent(fqdn) + "&user=" + encodeURIComponent(user);
  if (ip && CGNAT_RE.test(ip)) return u + "&ip=" + encodeURIComponent(ip);
  return u;
}
export function ghrdpRecredUrl(fqdn: string, user: string): string {
  return "ghrdp://recred?server=" + encodeURIComponent(fqdn) + "&user=" + encodeURIComponent(user);
}

export function validFqdnUser(fqdn: string, user: string): boolean {
  return FQDN_RE.test(fqdn) && USER_RE.test(user) && user !== "__USER__";
}

// Web-desktop verdict + guidance (F9i/F9k): keyed by the VERIFIED reason.
export interface WebdeskGuidance {
  guideHtml: string;
  adviceHtml: string;
}
const WD_DETAIL_TEXT: Record<string, string> = {
  "tightvnc-install": "TightVNC server installation failed on the host",
  "novnc-assets": "noVNC/websockify assets could not be prepared on the host",
  "websockify-bind": "websockify did not start on tailnet-IP:7333",
  "tailnet-ip-unavailable": "no valid tailnet IP was available, so no URL was advertised",
  "firewall-rule": "the tailnet-only firewall rule for TCP 7333 could not be created",
  "serve-mapping": "tailscale serve produced no tailnet mapping for the websockify port",
  "self-test-failed": "the advertised URL did not serve the noVNC page (self-test failed)",
  "vnc-auth-unverifiable": "VNC authentication could not be verified in either mode (password gate and tailnet-only probe both failed)",
  "listener-gone": "the websockify listener on tailnet-IP:7333 is no longer present",
};

function escWd(t: unknown): string {
  return String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export function webdeskGuidance(kind: string, deskReason: string, webdeskUrl: string, webdeskDetail: string): WebdeskGuidance {
  let guideHtml = "";
  let adviceHtml = "";
  if (!webdeskUrl) {
    if (deskReason === "vnc-pass-missing") {
      adviceHtml = 'Web desktop unavailable: set <code>VNC_PASS</code> in <a href="' + SECRETS_URL + '" target="_blank" rel="noopener">GitHub Actions secrets</a>, then re-run.';
      guideHtml =
        "VNC_PASS secret is missing. To enable web desktop:" +
        '<ol style="margin:6px 0 0 20px">' +
        '<li>Open <a href="' + SECRETS_URL + '" target="_blank" rel="noopener">GitHub Secrets Settings</a></li>' +
        '<li>Click &ldquo;New repository secret&rdquo;</li>' +
        "<li>Name: <code>VNC_PASS</code></li>" +
        "<li>Value: any strong password (min 8 chars, e.g. MySecureVNC2026!)</li>" +
        '<li>Click &ldquo;Add secret&rdquo;</li>' +
        "<li>Re-dispatch the workflow (Actions &rarr; Windows RDP &rarr; Run workflow &rarr; main &rarr; Run)</li>" +
        "</ol>" +
        "After re-dispatch, this button will enable automatically.";
    } else if (deskReason === "vnc-pass-too-short") {
      adviceHtml = "Web desktop unavailable: <code>VNC_PASS</code> is present but shorter than 8 characters - update the existing secret, do not re-add it.";
      guideHtml =
        "The <code>VNC_PASS</code> secret IS set, but it is shorter than 8 characters, so the web desktop was refused (weak passwords are not acceptable for a network-reachable service)." +
        '<ol style="margin:6px 0 0 20px">' +
        '<li>Open <a href="' + SECRETS_URL + '" target="_blank" rel="noopener">GitHub Secrets Settings</a></li>' +
        "<li>Find <code>VNC_PASS</code>, edit it, and set a strong value (min 8 chars)</li>" +
        "<li>Re-dispatch the workflow (Actions &rarr; Windows RDP &rarr; Run workflow &rarr; main &rarr; Run)</li>" +
        "</ol>";
    } else if (deskReason === "serve-failed") {
      const dCode = String(webdeskDetail || "");
      const dTxt = WD_DETAIL_TEXT[dCode] || "";
      adviceHtml = "Web desktop not deployed: host-side startup failure - this is NOT a missing VNC_PASS; do not re-add the secret.";
      guideHtml =
        "The web desktop backend failed to start on this host" + (dTxt ? " (" + dTxt + ")" : "") + ". Re-adding VNC_PASS will not fix this." +
        '<ol style="margin:6px 0 0 20px">' +
        '<li>Open <a href="' + ACTIONS_URL + '" target="_blank" rel="noopener">GitHub Actions</a> and read the &ldquo;Web desktop (noVNC + TightVNC&hellip;)&rdquo; step and its Step Summary for the specific sub-failure</li>' +
        "<li>Re-dispatch the workflow for a fresh ephemeral host</li>" +
        "</ol>";
    } else if (deskReason === "config-stale") {
      adviceHtml = "Web desktop stopped responding after deployment: the websockify listener on this host is gone.";
      guideHtml =
        "The web desktop URL was valid when this host was provisioned, but the websockify listener on tailnet-IP:7333 is no longer present." +
        (kind === "vps"
          ? " Check websockify on the VPS, or re-run the provisioning, then verify the URL again."
          : '<ol style="margin:6px 0 0 20px"><li>Re-dispatch the workflow for a fresh ephemeral host</li></ol>');
    } else if (deskReason === "step-not-run") {
      adviceHtml = "Web desktop not deployed yet for this host.";
      guideHtml =
        kind === "vps"
          ? "This VPS host has no operator-deployed web desktop yet. Deploy authenticated TightVNC (loopback) + websockify on the tailnet IP + the CGNAT-only firewall rule per MIGRATION.md &sect;1.10, then set the protected config.webdeskUrl."
          : 'The web desktop step has not completed for this run yet (it runs early in the workflow). Check the run in <a href="' + ACTIONS_URL + '" target="_blank" rel="noopener">GitHub Actions</a>; if it failed, re-dispatch.';
    } else if (deskReason === "invalid-webdesk-url") {
      adviceHtml = "The configured web desktop URL failed validation (must be tailnet http://100.64-127.x.x:7333/ or https://*.ts.net/ with no credentials).";
      guideHtml =
        "config.webdeskUrl is set but is not a valid tailnet URL (http://100.64-127.x.x:7333/ or https://*.ts.net/), so the value is hidden. Fix the web desktop step in the workflow and re-dispatch.";
    } else {
      adviceHtml = "Web desktop not deployed (reason: " + escWd(deskReason) + ").";
      guideHtml =
        'This web-desktop reason has no specific guidance. Open <a href="' + ACTIONS_URL + '" target="_blank" rel="noopener">GitHub Actions</a>, check the &ldquo;Web desktop&rdquo; step of the run that started this host, and re-dispatch.';
    }
  }
  return { guideHtml, adviceHtml };
}

// Valid tailnet desktop URL (F9n): http://CGNAT:7333 or legacy https://*.ts.net.
export function validWebdeskUrl(raw: unknown): string {
  let webdeskUrl = "";
  try {
    const desk = new URL(String(raw || ""));
    const tailHttp = desk.protocol === "http:" && CGNAT_RE.test(desk.hostname) && desk.port === "7333" && !desk.username && !desk.password;
    const legacyServe = desk.protocol === "https:" && FQDN_RE.test(desk.hostname) && !desk.username && !desk.password && !desk.port;
    if (tailHttp || legacyServe) webdeskUrl = desk.href;
  } catch {
    webdeskUrl = "";
  }
  return webdeskUrl;
}

// Tailscale auth-key halt guidance (F9k).
export function tsAuthGuidance(tsReason: string, tsAuthAdminUrl: unknown): { html: string; advice: string } {
  if (!/^ts-authkey-/.test(tsReason)) return { html: "", advice: "" };
  let keysUrl = "https://login.tailscale.com/admin/settings/keys";
  if (tsAuthAdminUrl && /^https:\/\/login\.tailscale\.com\/admin\//.test(String(tsAuthAdminUrl))) keysUrl = String(tsAuthAdminUrl);
  const isMissing = tsReason === "ts-authkey-missing";
  const html =
    (isMissing
      ? "The <code>TS_AUTHKEY</code> secret is NOT set, so the workflow halted fail-closed at the \u201cTailscale up\u201d step."
      : "The <code>TS_AUTHKEY</code> secret was REJECTED by Tailscale (" + escWd(tsReason) + "), so the workflow halted fail-closed at the \u201cTailscale up\u201d step.") +
    '<ol style="margin:6px 0 0 20px">' +
    '<li>Open <a href="' + keysUrl + '" target="_blank" rel="noopener">Tailscale admin - Settings - Keys</a></li>' +
    "<li>Generate a NEW auth key (reusable, Ephemeral on, 90 days)" +
    (isMissing ? "" : " - the old key is dead; do not reuse it") + "</li>" +
    "<li>Update the repository secret <code>TS_AUTHKEY</code> with the new value</li>" +
    "<li>Re-dispatch the workflow</li>" +
    "</ol>" +
    "No key material appears on this page, in any URL, or in any log.";
  const advice = isMissing
    ? "Workflow halted: TS_AUTHKEY secret missing - set it in GitHub Actions secrets, then re-run."
    : "Workflow halted: TS_AUTHKEY rejected (" + escWd(tsReason) + ") - generate a fresh key, update the secret, re-run.";
  return { html, advice };
}

// [F15 §3] launcher beacon row + stall verdict.
export const BEACON_STALL_MS = 45000;
export const LAUNCHER_LOG = "%LOCALAPPDATA%\\ghrdp\\ghrdp-launcher.log";
export function beaconModel(b: Any, invokedAt: number | null, nowMs: number): {
  text: string;
  tone: "ok" | "warn" | "bad" | "neutral";
  stall: string;
  newInvokedAt: number | null;
} {
  let text = "(none yet - click WINDOWS AUTO-LOGIN; a stale registration posts no beacon)";
  let tone: "ok" | "warn" | "bad" | "neutral" = "neutral";
  let stall = "";
  let newInvokedAt = invokedAt;
  if (b && b.ts) {
    const t = parseTsUtc(b.ts);
    const age = isNaN(t) ? null : Math.max(0, Math.round((nowMs - t) / 1000));
    text = "verb=" + (b.verb || "?") + " details=" + (b.details || "(none)") + " ok=" + (b.ok ? "true" : "false") + " age=" + (age === null ? "?" : age) + "s";
    tone = b.ok === false ? "bad" : "neutral";
    const det = b.details ? String(b.details) : "";
    if (det === "invoked") {
      if (!newInvokedAt) newInvokedAt = isNaN(t) ? nowMs : t;
      if (nowMs - (newInvokedAt as number) >= BEACON_STALL_MS) {
        stall = "launcher stalled at: " + det + " - open " + LAUNCHER_LOG;
      }
    } else {
      newInvokedAt = 0;
    }
  }
  return { text, tone, stall, newInvokedAt };
}

// RDP usage ticker (F11-3): ticks while active, freezes when frozen.
export function rdpUsageSeconds(u: { sec: number; active: boolean; at: number } | null, logonFallback: { sec: number; at: number } | null, nowMs: number): { sec: number; active: boolean } {
  if (u) return { sec: u.sec + (u.active ? (nowMs - u.at) / 1000 : 0), active: u.active };
  if (logonFallback) return { sec: logonFallback.sec + (nowMs - logonFallback.at) / 1000, active: false };
  return { sec: null as unknown as number, active: false };
}
