// [F41] LIVE DISPATCH STATUS (F31c §2) - faithful TS port: 5 checks, exact
// failing condition + one fix. Pure, no DOM.
import { asList } from "./telescope";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface LiveDispatchCheck {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

export interface LiveDispatchResult {
  ok: boolean;
  checks: LiveDispatchCheck[];
  failed: LiveDispatchCheck[];
  fix: string;
}

function liveDispatchAgeMs(ts: unknown, now: number): number | null {
  if (!ts) return null;
  const t = Date.parse(String(ts));
  if (isNaN(t)) return null;
  return now - t;
}

function liveDispatchInWindow(ts: unknown, now: number, windowMs: number): boolean {
  const age = liveDispatchAgeMs(ts, now);
  if (age == null) return true;
  return age <= windowMs;
}

export function liveDispatchStatus(s: Any | null | undefined, nowMs?: number): LiveDispatchResult {
  s = s || {};
  const now = nowMs == null ? Date.now() : nowMs;
  const rl = s.rdpListener || {};
  const checks: LiveDispatchCheck[] = [];
  const ip = String(s.runnerResolvedIP || "");
  const ping = s.pingMs == null || s.pingMs === "" ? null : Number(s.pingMs);
  const ipOk = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
  const pingOk = ping != null && !isNaN(ping) && ping >= 0 && ping < 500;
  const c1: LiveDispatchCheck = { id: "runner", name: "Runner reachable", ok: !!(ipOk && pingOk), detail: "", fix: "" };
  if (!ip) {
    c1.detail = "runnerResolvedIP absent";
    c1.fix = "runnerResolvedIP absent => re-dispatch main.yml (F18 runner FQDN self-test)";
  } else if (!ipOk) {
    c1.detail = "runnerResolvedIP not a tailnet address";
    c1.fix = "runnerResolvedIP not a tailnet address => re-dispatch main.yml";
  } else if (ping == null || isNaN(ping)) {
    c1.detail = "ping not reported";
    c1.fix = "ping not reported => wait for the 15s tailscale ping, or re-dispatch if the runner is down";
  } else if (!(ping < 500)) {
    c1.detail = "ping=" + ping + "ms (>= 500ms)";
    c1.fix = "ping=" + ping + "ms (>= 500ms) => check Tailscale direct path (UDP 41641)";
  } else {
    c1.detail = "runnerResolvedIP=" + ip + " ping=" + ping + "ms";
  }
  checks.push(c1);

  const hs = rl.listenerHandshakeOk === true;
  checks.push({
    id: "f31",
    name: "F31 bound",
    ok: hs,
    detail: hs ? "rdpListener.listenerHandshakeOk=true" : "F31 not bound",
    fix: hs ? "" : "F31 not bound => re-dispatch main.yml",
  });

  const cl = rl.connLog || s.connLog || null;
  const items = cl ? asList(cl.items && cl.items.length ? cl.items : cl.newest) : [];
  let hit: Any = null;
  for (let i = 0; i < items.length; i++) {
    const e = items[i] || {};
    const eid = String(e.id == null ? "" : e.id);
    const blob = eid + " " + String(e.reason || "") + " " + String(e.desc || "");
    if (eid === "36870" || blob.indexOf("36870") >= 0) {
      if (liveDispatchInWindow(e.timeUtc || e.ts || "", now, 5 * 60 * 1000)) {
        hit = e;
        break;
      }
    }
  }
  const c3: LiveDispatchCheck = { id: "schannel", name: "36870 absent", ok: false, detail: "", fix: "" };
  if (!cl) {
    c3.detail = "connLog not reported";
    c3.fix = "connLog not reported => 36870 absence not proven => re-dispatch main.yml";
  } else if (hit) {
    c3.detail = "36870 present";
    c3.fix = "36870 present => key ACL dump needed => copy-line to session";
  } else if (cl.schannelProbeError) {
    c3.detail = "System Schannel log unreadable";
    c3.fix = "System Schannel log unreadable => 36870 absence not proven => copy-line to session";
  } else {
    c3.ok = true;
    c3.detail = "no 36870 events in last 5 minutes";
  }
  checks.push(c3);

  const beacons = asList(s.launcher && s.launcher.beacons);
  const texts: string[] = [];
  for (let j = 0; j < beacons.length; j++) {
    const b = beacons[j];
    texts.push(b && typeof b === "object" ? String(b.details || b.detail || "") : String(b || ""));
  }
  let start = 0;
  for (let k = 0; k < texts.length; k++) {
    if (/^(invoked|ticket-redeemed|recred-redeemed)$/.test(texts[k])) start = k;
  }
  const attempt = texts.slice(start);
  let stored = false;
  if (texts.length) {
    for (let a = 0; a < attempt.length; a++) {
      if (attempt[a].indexOf("credwrite-ok") >= 0) stored = true;
    }
  }
  checks.push({
    id: "cred",
    name: "Credential stored",
    ok: stored,
    detail: stored ? "launcher.beacons contains credwrite-ok in last attempt" : "credwrite-ok absent from last attempt",
    fix: stored ? "" : "credwrite-ok absent from last attempt => click WINDOWS AUTO-LOGIN (ticket -> CredWrite); read the launcher beacon row if the chain stops earlier",
  });

  const ae = rl.authEvents || null;
  const evs = ae ? asList(ae.events && ae.events.length ? ae.events : ae.items || []) : [];
  let logonHit = false;
  let logonDetail = "no 4624 type10 in last 10 minutes";
  for (let n = 0; n < evs.length; n++) {
    const ev = evs[n] || {};
    const evid = String(ev.id || ev.eventId || "");
    const lt = String(ev.logonType || ev.LogonType || ev.type || "");
    if (evid === "4624" && (lt === "10" || lt.toLowerCase() === "type10")) {
      const ets = ev.timeUtc || ev.ts || "";
      const age = ets ? liveDispatchAgeMs(ets, now) : null;
      if (age != null && age <= 10 * 60 * 1000 && age >= -60000) {
        logonHit = true;
        logonDetail = "4624 type10 at " + ets;
        break;
      }
    }
  }
  if (!logonHit && ae) {
    const c4624 = Number(ae.count4624);
    const last = ae.last4624At || "";
    const la = liveDispatchAgeMs(last, now);
    if (c4624 > 0 && last && la != null && la <= 10 * 60 * 1000 && la >= -60000) {
      logonHit = true;
      logonDetail = "4624 type10 at " + last + " (count4624=" + c4624 + ")";
    }
  }
  checks.push({
    id: "logon",
    name: "Logon success",
    ok: logonHit,
    detail: logonDetail,
    fix: logonHit ? "" : "no 4624 type10 in last 10 minutes => click WINDOWS AUTO-LOGIN; if the session never reaches LSA, read SERVER CONN LOG (a pre-logon drop never writes 4624)",
  });

  const failed: LiveDispatchCheck[] = [];
  for (let f = 0; f < checks.length; f++) if (!checks[f].ok) failed.push(checks[f]);
  return { ok: failed.length === 0, checks, failed, fix: failed.length ? failed[0].fix : "" };
}
