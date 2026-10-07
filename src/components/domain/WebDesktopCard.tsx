// [F41 plan §2 WebDesktopCard] WEB DESKTOP card (id="sec-native-rdp"): deploy
// status (F9i keyed guidance per VERIFIED reason), MagicDNS/Advisory/VPS rows,
// host kind (ephemeral/VPS), cmdkey gate + VPS native auto-login, webdesk URL
// + VNC auth mode, TS_AUTHKEY halt guidance (F9k), VNC password memory
// (postMessage shim, F11-2), shortcut copy-lines, ticket audit.
import React, { useEffect, useMemo, useState } from "react";
import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { CopyButton } from "@/components/primitives/Copy";
import { useSessionStore } from "@/stores/sessionStore";
import { FQDN_RE } from "@/lib/format";
import { MAGIC_DNS_ADMIN_URL, REASON_TEXT, tsAuthGuidance, validFqdnUser, validWebdeskUrl, webdeskGuidance } from "@/lib/domain/native";

function Row({ k, children, id, className, column }: { k?: string; children: React.ReactNode; id?: string; className?: string; column?: boolean }) {
  return (
    <div
      id={id}
      className={
        (column ? "flex flex-col items-stretch gap-1.5" : "flex flex-wrap items-center gap-2") +
        " py-1.5 border-b border-default last:border-0 " +
        (className || "")
      }
    >
      {k && <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">{k}</span>}
      <div className="flex flex-wrap items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}

export function WebDesktopCard() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const fqdn = useSessionStore((s) => s.fqdn);
  const user = useSessionStore((s) => s.user);
  const s = native || {};

  // [F41] build-drift warn (v1 contract): if the served bundle is older than
  // origin/main, tell the operator to re-dispatch. Silent on any failure
  // (offline runners, rate limits, forks). 10-min cadence.
  const [buildDrift, setBuildDrift] = useState("");
  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctl ? window.setTimeout(() => ctl.abort(), 5000) : 0;
        const r = await fetch("https://api.github.com/repos/dekarita/supreme-lamp/commits/main", { cache: "no-store", credentials: "omit", signal: ctl?.signal });
        if (timer) window.clearTimeout(timer);
        if (!r.ok) return;
        const j = (await r.json()) as { sha?: string };
        const head = (j.sha || "").slice(0, 7);
        const mine = String(__BUILD_SHA__).slice(0, 7);
        if (alive && head && mine !== "dev" && head !== mine) setBuildDrift(head);
      } catch {
        /* offline / rate-limited: stay silent */
      }
    }
    void check();
    const id = window.setInterval(check, 600000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const hostKind = s.hostKind === "vps" ? "vps" : "ephemeral";
  const reasonsDisabled = (Array.isArray(s.reasonsDisabled) ? s.reasonsDisabled : []) as string[];
  const probeReasons = s.probeReasons || {};
  const credOkLocal = validFqdnUser(fqdn, user);
  const srvReasons = credOkLocal ? reasonsDisabled.filter((x: string) => x !== "no-cmdkey-entry") : reasonsDisabled;
  const reasonMap: Record<string, string> = {
    "fqdn-not-tsnet": probeReasons.fqdn,
    "cert-not-bound": probeReasons.cert,
    "nla-off": probeReasons.nla,
    "no-cmdkey-entry": probeReasons.cmdkey,
  };
  const admin = s.magicDnsAdminUrl || MAGIC_DNS_ADMIN_URL;
  const reasons: string[] = srvReasons.map((x: string) => reasonMap[x] || REASON_TEXT[x] || x);

  const advisory = (Array.isArray(s.advisory) ? s.advisory : []).join(" | ");
  const webdeskUrl = validWebdeskUrl(s.webdeskUrl);
  const deskReason = s.webdeskUrl ? "invalid-webdesk-url" : s.webdeskReason || "step-not-run";
  const guidance = useMemo(() => webdeskGuidance(hostKind, deskReason, webdeskUrl, s.webdeskDetail), [hostKind, deskReason, webdeskUrl, s.webdeskDetail]);
  const ts = tsAuthGuidance(String(s.tsReason || "") || (/^ts-authkey-/.test(deskReason) ? deskReason : ""), s.tsAuthAdminUrl);

  const [cmdkeyConfirmed, setCmdkeyConfirmed] = useState(false);
  useEffect(() => {
    try {
      setCmdkeyConfirmed(localStorage.getItem("ghrdp.cmdkeyConfirmedFqdn") === fqdn);
    } catch {
      setCmdkeyConfirmed(false);
    }
  }, [fqdn]);

  const [vncInput, setVncInput] = useState("");
  const [vncRemember, setVncRemember] = useState(false);
  const [vncState, setVncState] = useState("not stored");
  useEffect(() => {
    try {
      const stored = !!localStorage.getItem("ghrdp:vncPass");
      setVncRemember(stored);
      setVncState(stored ? "stored on this device" : "not stored");
    } catch {
      /* ignore */
    }
  }, []);

  const nativeReady = srvReasons.length === 0;
  const nativeBtnOk = hostKind === "vps" && nativeReady && FQDN_RE.test(fqdn) && cmdkeyConfirmed && credOkLocal;


  const readyText =
    hostKind === "vps"
      ? nativeReady
        ? "native shortcut ready"
        : ""
      : srvReasons.length === 0 && webdeskUrl
        ? "WEB DESKTOP ready"
        : !webdeskUrl
          ? "web desktop not deployed: " + deskReason
          : "";
  const readyTone = readyText.indexOf("ready") >= 0 ? "var(--color-success)" : "var(--color-warning)";

  const ticketAudit = s.ticketAudit || {};
  const auditText = "issued=" + (ticketAudit.issued || 0) + " redeemed=" + (ticketAudit.redeemed || 0) + " rejected=" + (ticketAudit.rejected || 0);

  const cmdkeyLine = FQDN_RE.test(fqdn)
    ? "cmdkey /generic:TERMSRV/" + fqdn + " /user:" + (user || "rdpuser")
    : "(fqdn missing - provision the VPS per docs/MIGRATION.md sec 1.7)";
  const mstscLine = FQDN_RE.test(fqdn) ? "mstsc /v:" + fqdn : "(fqdn missing)";

  function rememberVnc() {
    try {
      if (vncRemember && vncInput) {
        localStorage.setItem("ghrdp:vncPass", vncInput);
        setVncState("stored on this device");
        // F11-2: postMessage only to same-origin noVNC frames; never a URL/log.
        window.frames && Array.from(window.frames).forEach((f) => {
          try {
            f.postMessage({ ghrdpVncPass: vncInput }, window.location.origin);
          } catch {
            /* cross-origin frame - skip */
          }
        });
        setVncInput("");
      } else if (!vncRemember) {
        localStorage.removeItem("ghrdp:vncPass");
        setVncState("not stored");
      }
    } catch {
      /* ignore */
    }
  }
  function forgetVnc() {
    try {
      localStorage.removeItem("ghrdp:vncPass");
    } catch {
      /* ignore */
    }
    setVncRemember(false);
    setVncState("not stored");
  }

  return (
    <Card id="sec-native-rdp" title={t("webDesktop.title")} icon={<Globe className="size-4 text-tertiary" aria-hidden />} className="mb-4">
      <Row id="nrBuildWarn" k="Deploy" className={buildDrift ? "" : "hidden"}>
        <span id="nrBuildWarnText" className="text-xs text-warning">
          deployed UI older than origin/main (HEAD {buildDrift}) - re-dispatch the deploy workflow to refresh this dashboard
        </span>
      </Row>
      <Row k={t("webDesktop.status")}>
        <span id="nrReady" className="text-sm" style={{ color: readyTone }}>
          {readyText}
        </span>
      </Row>
      <Row id="nrReadyRow" k={t("webDesktop.ready")} className={readyText ? "" : "hidden"} column>
        <span id="nrReadyDup" className="text-sm" style={{ color: readyTone }}>
          {readyText || "--"}
        </span>
      </Row>
      <Row id="nrAdvisoryRow" k={t("webDesktop.advisory")} className={advisory ? "" : "hidden"}>
        <span id="nrAdvisory" className="text-xs text-warning">
          {advisory}
        </span>
      </Row>
      <Row
        id="nrMagicDnsRow"
        k={t("webDesktop.magicDns")}
        className={hostKind === "ephemeral" && !FQDN_RE.test(fqdn) ? "" : "hidden"}
      >
        <span id="nrMagicDns" className="text-xs text-warning">
          {hostKind === "ephemeral" && !FQDN_RE.test(fqdn) ? (
            <>
              workflow halted until MagicDNS enabled - open the admin link, enable, re-dispatch:{" "}
              <a href={admin} target="_blank" rel="noopener" className="text-accent underline">
                {admin}
              </a>
            </>
          ) : (
            ""
          )}
        </span>
      </Row>
      <Row id="nrReasonsRow" k={t("webDesktop.blockedBy")} className={reasons.length ? "" : "hidden"}>
        <span id="nrReasons" className="text-xs text-danger">
          {reasons.map((r, i) => (
            <span key={i}>
              {i > 0 ? " | " : ""}
              <ReasonWithLink text={r} admin={admin} />
            </span>
          ))}
        </span>
      </Row>
      <Row id="nrVpsPendingRow" k={t("webDesktop.vpsStatus")} className={s.vpsPending ? "" : "hidden"}>
        <span id="nrVpsPending" className="text-xs text-warning">
          provisioning pending (advisory)
        </span>
      </Row>
      <Row k={t("webDesktop.host")}>
        <span id="nrHostKind" className="text-sm" style={{ color: hostKind === "vps" ? "" : "var(--color-warning)" }}>
          {hostKind}
        </span>
        <span id="nrHostKindNote" className="text-xs text-tertiary">
          ephemeral runners change name every run. A one-time TERMSRV entry is VPS-only.
        </span>
      </Row>
      <Row id="nrEphemeralRow" className={hostKind === "vps" ? "hidden" : ""} column>
        <span className="text-sm font-semibold text-primary">WEB DESKTOP (primary) + shortcut instructions</span>
        <span className="text-xs text-secondary">
          This host is ephemeral. Click WEB DESKTOP. Do not expect a stored TERMSRV entry to survive the next run. One-time cmdkey is VPS-only.
        </span>
      </Row>
      <Row id="nrVpsShortcutRow" className={hostKind === "vps" ? "" : "hidden"} column>
        <span className="text-sm font-semibold text-primary">Native auto-login (VPS only)</span>
        <span className="text-xs text-secondary">
          One time on your PC: install the compiled protocol handler (see docs/AUTOLOGIN.md), run the cmdkey line below, and type the password at the Windows prompt.
          Neither the page nor the handler reads that password.
        </span>
        <label className="flex items-center gap-2 text-xs text-secondary">
          <input
            id="nrCmdkeyConfirmed"
            type="checkbox"
            checked={cmdkeyConfirmed}
            onChange={(e) => {
              const checked = e.target.checked;
              setCmdkeyConfirmed(checked);
              try {
                if (checked && FQDN_RE.test(fqdn)) localStorage.setItem("ghrdp.cmdkeyConfirmedFqdn", fqdn);
                else localStorage.removeItem("ghrdp.cmdkeyConfirmedFqdn");
              } catch {
                /* ignore */
              }
            }}
          />
          I ran cmdkey for this FQDN on this PC (copying the line does not count).
        </label>
        <Button id="autoLoginNative" variant="primary" size="sm" disabled={!nativeBtnOk} onClick={() => void useSessionStore.getState().fireAutoLoginNative()} data-testid="overview-auto-login-vps">
          {t("actions.autoLoginVps")}
        </Button>
      </Row>
      <Row k={t("webDesktop.url")}>
        <span
          id="webdeskUrlVal"
          className="font-mono text-sm text-text-mono break-all"
          title={webdeskUrl}
          data-full={webdeskUrl || undefined}
        >
          {webdeskUrl ? new URL(webdeskUrl).hostname : s.webdeskUrl ? "(invalid URL)" : "(not set)"}
        </span>
        <CopyButton value={() => webdeskUrl} data-testid="overview-copy-webdesk-url" />
        <span className="text-xs text-tertiary">VNC password = the VNC_PASS secret set at dispatch; this page never stores or shows it.</span>
      </Row>
      <Row k={t("webDesktop.authMode")}>
        <span id="webdeskAuthVal" className="text-sm">
          {s.webdeskAuthMode ? String(s.webdeskAuthMode) : "(unknown)"}
        </span>
      </Row>
      <div id="webdeskAuthAdvisory" className={s.webdeskAuthAdvisory ? "py-1.5 border-b border-default" : "hidden"}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">{t("webDesktop.advisory")}</span>
          <span id="webdeskAuthAdvisoryText" className="text-xs text-warning">
            {s.webdeskAuthAdvisory ? String(s.webdeskAuthAdvisory) : ""}
          </span>
        </div>
      </div>
      <div
        id="webdeskVncGuidance"
        className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-md p-3 my-2 [&_a]:text-accent [&_a]:underline"
        style={guidance.guideHtml ? undefined : { display: "none" }}
        dangerouslySetInnerHTML={{ __html: guidance.guideHtml }}
      />
      <div id="webdeskVncAdvisory" className={guidance.adviceHtml ? "py-1.5 border-b border-default" : "hidden"}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">{t("webDesktop.advisory")}</span>
          <span id="webdeskVncAdvisoryText" className="text-xs text-warning" dangerouslySetInnerHTML={{ __html: guidance.adviceHtml }} />
        </div>
      </div>
      <div
        id="tsAuthGuidance"
        className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-md p-3 my-2 [&_a]:text-accent [&_a]:underline"
        style={ts.html ? undefined : { display: "none" }}
        dangerouslySetInnerHTML={{ __html: ts.html }}
      />
      <div id="tsAuthAdvisory" className={ts.advice ? "py-1.5 border-b border-default" : "hidden"}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">{t("webDesktop.advisory")}</span>
          <span id="tsAuthAdvisoryText" className="text-xs text-warning">
            {ts.advice}
          </span>
        </div>
      </div>
      <Row k={t("webDesktop.vncMemory")} column>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="vncPassInput"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("webDesktop.vncPlaceholder")}
            value={vncInput}
            onChange={(e) => setVncInput(e.target.value)}
            className="bg-sunken border border-strong rounded-md px-2.5 py-1.5 text-sm text-primary placeholder:text-tertiary min-w-[220px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <label className="flex items-center gap-2 text-xs text-secondary">
            <input id="vncPassRemember" type="checkbox" checked={vncRemember} onChange={() => rememberVnc()} />
            {t("webDesktop.vncRemember")}
          </label>
          <Button id="vncPassForget" variant="secondary" size="sm" onClick={forgetVnc} data-testid="overview-vnc-forget">
            {t("webDesktop.vncForget")}
          </Button>
          <span id="vncPassState" className="text-xs text-tertiary">
            {vncState}
          </span>
        </div>
        <span className="text-xs text-tertiary">
          After the first entry, WEB DESKTOP auto-fills the noVNC Credentials dialog via postMessage from this page&apos;s origin only. The value never appears in a URL,
          query string, artifact, or log.
        </span>
      </Row>
      <Row k={t("webDesktop.shortcutText")} column>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-tertiary">{t("webDesktop.cmdkeyLine")}</span>
          <code id="cmdkeyLine" className="font-mono text-xs bg-sunken border border-default rounded px-2 py-1 text-success break-all">
            {cmdkeyLine}
          </code>
          <CopyButton value={cmdkeyLine} data-testid="overview-copy-cmdkey-line" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-tertiary">{t("webDesktop.mstscLine")}</span>
          <code id="mstscFallback" className="font-mono text-xs bg-sunken border border-default rounded px-2 py-1 text-success break-all">
            {mstscLine}
          </code>
          <CopyButton value={mstscLine} data-testid="overview-copy-mstsc-line" />
        </div>
        <span className="text-xs text-tertiary">
          Password is typed at the prompt, never placed on the command line. Ephemeral hosts: ignore this pair and use WEB DESKTOP.
        </span>
      </Row>
      <Row k={t("webDesktop.ticketAudit")}>
        <span id="ticketAudit" className="font-mono text-sm text-text-mono">
          {s.ticketAudit ? auditText : "not reported yet"}
        </span>
      </Row>
    </Card>
  );
}

function ReasonWithLink({ text, admin }: { text: string; admin: string }) {
  const i = text.indexOf(admin);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <a href={admin} target="_blank" rel="noopener" className="text-accent underline">
        {admin}
      </a>
      {text.slice(i + admin.length)}
    </>
  );
}
