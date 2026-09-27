// [F41] ONE TIMELINE (F37 §3) - faithful TS port of the F38 ui.html telescope
// module. The vocabulary is payloads/rdp-telescope.ps1's (single source of
// truth): stages dns|tcp|tls|cred|logon|schannel|listener, failure points
// rst-before-cert|chain|name-mismatch|eku, death points
// dns|tcp|tls-cert|tls-chain|tls-eku|name-mismatch|credssp|logon|acl|none.
// telescopeTimeline is PURE (no DOM, no fetch) so the smoke tests and the lab
// can execute it against synthetic native-status samples - same contract v1 kept.

export interface TelSegment {
  src: string;
  stage: string;
  label: string;
  ok: boolean | null;
  detail: string;
  slug?: string;
  failureAt?: string;
  ts: string;
  trace: string;
}

export interface TelTimeline {
  trace: string;
  segments: TelSegment[];
  deathPoint: string;
  ok: boolean;
  fix: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const TEL_STAGE_ORDER = ["dns", "tcp", "tls", "cred", "listener", "schannel", "logon"];

export const TEL_CLIENT_DETAIL: Record<string, string> = {
  "telescope-dns-ok": "name resolved",
  "telescope-dns-fail": "name did not resolve (Tailscale DNS off / stale resolver cache)",
  "telescope-tcp-ok": "3389 reachable",
  "telescope-tcp-fail": "3389 refused/filtered",
  "telescope-tls-ok": "X.224+TLS ok, served==bound",
  "telescope-rst-before-cert": "reset before a certificate was presented (Schannel refused the listener key/cert)",
  "telescope-chain": "certificate served, chain rejected",
  "telescope-name-mismatch": "certificate does not cover the FQDN",
  "telescope-eku": "served certificate lacks the Server Authentication EKU",
  "telescope-cred-ok": "stored TERMSRV target present (metadata only)",
  "telescope-cred-missing": "no stored TERMSRV target on this PC",
};

export const TEL_DEATH_FIX: Record<string, string> = {
  dns: "client DNS: tailscale set --accept-dns=true, ipconfig /flushdns, then click WINDOWS AUTO-LOGIN again",
  tcp: "nothing accepted TCP 3389: the runner listener/firewall is down - read the RDP LISTENER row and re-dispatch main.yml",
  "tls-cert": "the listener reset BEFORE presenting a certificate: Schannel refused the key/cert (persisted-key ACL, missing ServerAuth EKU, or no bind) - see SERVER CONN LOG (36870) and the ACL line above",
  "tls-chain": "a certificate WAS served and the chain did not validate: check the bound cert/issuer on the host",
  "tls-eku": "the served certificate has no Server Authentication EKU: rebind a ServerAuth certificate (this is the lab red class)",
  "name-mismatch": "the served certificate does not cover this FQDN: rebind the cert for the exact MagicDNS name",
  credssp: "no stored TERMSRV target on this PC: click WINDOWS AUTO-LOGIN (ticket -> CredWrite) or FIX & RECONNECT",
  acl: "the persisted private-key ACL does not grant NETWORK SERVICE read (36870 class): re-dispatch main.yml (F31 ACL gate)",
  logon: "the handshake completed but no 4624 type-10 arrived: the host refused the logon (read the 4625 SubStatus above)",
  none: "",
};

export function telescopeDeathFix(dp: unknown): string {
  return TEL_DEATH_FIX[String(dp || "none")] || "";
}

export function asList(v: unknown): Any[] {
  if (!v) return [];
  if (typeof v === "string") return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object") return [v];
  return [];
}

function telescopeParseLine(l: unknown): Any | null {
  if (l && typeof l === "object") return l;
  try {
    return JSON.parse(String(l));
  } catch {
    return null;
  }
}

export function telescopeClientSegments(s: Any | null | undefined): { segments: TelSegment[]; trace: string } {
  const tc = (s && s.telescopeClient) || null;
  let items = (tc && tc.items && tc.items.length) ? tc.items : [];
  if (!items.length && s && s.launcher && s.launcher.telescope) items = asList(s.launcher.telescope);
  const trace = String((tc && tc.newestTrace) || "");
  const segs: TelSegment[] = [];
  const seen: Record<string, boolean> = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const t = String(it.trace || "");
    if (trace && t && t !== trace) continue;
    const stage = String(it.stage || "");
    if (!stage || seen["c:" + stage]) continue;
    seen["c:" + stage] = true;
    const det = String(it.details || "");
    // [F37 §3] telescope-unparsed means the server's allowlist NEUTRALIZED the
    // beacon (unknown/secret-shaped details). That is not a stage verdict, so
    // it must never become a death point.
    const neutralized = det === "telescope-unparsed";
    let cls = "";
    if (det === "telescope-rst-before-cert") cls = "rst-before-cert";
    else if (det === "telescope-chain") cls = "chain";
    else if (det === "telescope-name-mismatch") cls = "name-mismatch";
    else if (det === "telescope-eku") cls = "eku";
    segs.push({
      src: "client",
      stage,
      label: String(stage),
      ok: neutralized ? null : it.ok === true ? true : it.ok === false ? false : null,
      detail: neutralized ? "beacon neutralized by the server allowlist (not a stage verdict)" : TEL_CLIENT_DETAIL[det] || det || "(no detail)",
      slug: det,
      failureAt: cls,
      ts: String(it.ts || ""),
      trace: t || trace,
    });
  }
  if (!segs.length)
    segs.push({ src: "client", stage: "diag", label: "diag", ok: null, detail: "no client beacons yet - click [RUN DIAG] (read-only: dns/tcp/tls/cred)", ts: "", trace });
  return { segments: segs, trace };
}

export function telescopeRunnerSegments(s: Any | null | undefined): { segments: TelSegment[]; telescope: Any | null } {
  const rl = (s && s.rdpListener) || {};
  const tel = rl && rl.telescopeLive ? rl.telescopeLive : rl && rl.telescope ? rl.telescope : s && s.telescope ? s.telescope : null;
  const segs: TelSegment[] = [];
  if (!tel) return { segments: segs, telescope: null };
  const lines = asList(tel.lines);
  for (let i = 0; i < lines.length; i++) {
    const o = telescopeParseLine(lines[i]);
    if (!o || !o.stage) continue;
    let det = "";
    if (o.stage === "dns") det = "ip=" + String(o.ip || "(none)");
    if (o.stage === "tcp") det = "ip=" + String(o.ip || "") + " port=" + String(o.port == null ? "" : o.port) + " rttMs=" + String(o.rttMs == null ? "" : o.rttMs);
    if (o.stage === "tls")
      det =
        "servedThumb=" + String(o.servedThumb || "(none, no certificate presented)") +
        " chainOk=" + String(o.chainOk === true) +
        " nameMatch=" + String(o.nameMatch === true) +
        " serverAuth=" + String(o.serverAuth === true);
    if (o.stage === "listener")
      det =
        "bound=" + String(o.boundThumb || "(none)") +
        " served=" + String(o.servedThumb || "(none)") +
        " aclRead=" + String(o.aclRead === true) +
        " container=" + String(o.container || "(none)");
    if (o.stage === "schannel") det = "events=[" + asList(o.schannelIds).join(",") + "]";
    if (o.stage === "logon")
      det = "last=" + String(o.eventId || "(none)") + " sub=" + String(o.sub || "") + " 4624=" + String(o.count4624 == null ? "" : o.count4624) + " 4625=" + String(o.count4625 == null ? "" : o.count4625);
    if (o.ok !== true && o.failureAt) det = "failureAt=" + String(o.failureAt) + " " + det;
    if (o.ok !== true && o.why) det = det + " why=" + String(o.why);
    segs.push({
      src: "runner",
      stage: String(o.stage),
      label: String(o.stage),
      ok: o.ok === true,
      detail: det,
      ts: String(o.ts || ""),
      trace: String(o.trace || ""),
      failureAt: String(o.failureAt || ""),
    });
  }
  return { segments: segs, telescope: tel };
}

export function telescopeLogonSegments(s: Any | null | undefined, runnerHasLogon: boolean): TelSegment[] {
  if (runnerHasLogon) return [];
  const rl = (s && s.rdpListener) || {};
  const ae = rl.authEvents || null;
  if (!ae) return [];
  const c24 = Number(ae.count4624 || 0);
  const c25 = Number(ae.count4625 || 0);
  const sub = String(ae.sub || ae.lastSubStatus || "");
  return [
    {
      src: "logon",
      stage: "logon",
      label: "logon",
      ok: c24 > 0,
      detail: "4624=" + c24 + " 4625=" + c25 + (sub ? " sub=" + sub : ""),
      ts: String(ae.last4624At || ""),
      trace: "",
    },
  ];
}

export function telescopeDeathFromSegment(seg: TelSegment | null | undefined): string {
  if (!seg || seg.ok !== false) return "none";
  const st = String(seg.stage || "");
  if (st === "dns") return "dns";
  if (st === "tcp") return "tcp";
  if (st === "tls") {
    const f = String(seg.failureAt || "") + " " + String(seg.detail || "");
    if (/rst-before-cert|served!=bound|handshake-aborted|skipped/.test(f)) return "tls-cert";
    if (/name-mismatch/.test(f)) return "name-mismatch";
    if (/eku/.test(f)) return "tls-eku";
    return "tls-chain";
  }
  if (st === "cred") return "credssp";
  if (st === "listener") return "acl";
  if (st === "logon") return "logon";
  return "none";
}

export function telescopeTimeline(s: Any | null | undefined, _nowMs?: number): TelTimeline {
  const cli = telescopeClientSegments(s);
  const run = telescopeRunnerSegments(s);
  let hasLogon = false;
  for (let i = 0; i < run.segments.length; i++) {
    if (run.segments[i].stage === "logon") hasLogon = true;
  }
  const segs = cli.segments.concat(run.segments).concat(telescopeLogonSegments(s, hasLogon));
  segs.sort((a, b) => {
    let ia = TEL_STAGE_ORDER.indexOf(a.stage);
    let ib = TEL_STAGE_ORDER.indexOf(b.stage);
    if (ia < 0) ia = TEL_STAGE_ORDER.length + 1;
    if (ib < 0) ib = TEL_STAGE_ORDER.length + 1;
    if (ia !== ib) return ia - ib;
    const ra = a.src === "client" ? 0 : 1;
    const rb = b.src === "client" ? 0 : 1;
    return ra - rb;
  });
  let death = "none";
  for (let j = 0; j < segs.length; j++) {
    if (segs[j].stage === "schannel") continue; // evidence, never a segment verdict
    const d = telescopeDeathFromSegment(segs[j]);
    if (d !== "none") {
      death = d;
      break;
    }
  }
  if (death === "none" && run.telescope && run.telescope.deathPoint && run.telescope.deathPoint !== "none")
    death = String(run.telescope.deathPoint);
  return { trace: cli.trace, segments: segs, deathPoint: death, ok: death === "none", fix: telescopeDeathFix(death) };
}

export function telescopeSegmentText(seg: TelSegment): string {
  const mark = seg.ok === true ? "ok" : seg.ok === false ? "FAIL" : "--";
  return "[" + seg.src + "] " + seg.stage + " " + mark + " " + seg.detail;
}
