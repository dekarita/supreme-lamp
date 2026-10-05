// [F41 plan §5.1 + §2 PrimaryActions] Overview page header: title, FQDN +
// cert/NLA/CredSSP chips, the three primary actions (#btnWinAuto,
// #btnWebDesk, #btnFixReconnect), banners, and the F28 one-click recovery row.
// Functional parity (§3): #btnWinAuto fires the EXISTING ticket flow
// (POST /api/rdp-token -> ghrdp://rdp?server&user&t), #btnWebDesktop opens the
// validated noVNC URL, #btnFixReconnect is conditional on 0xC000006A+chain.
import { useState } from "react";
import { AlertTriangle, ExternalLink, Globe, Monitor, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/sessionStore";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { Button } from "@/components/primitives/Button";
import { Chip, StatusDot } from "@/components/primitives/Chip";
import { CopyLink } from "@/components/primitives/Copy";
import { cn } from "@/lib/cn";
import { FQDN_RE, SESSION_WINDOW_MS } from "@/lib/format";
import { credsspChip, recoveryDecision, validFqdnUser, validWebdeskUrl } from "@/lib/domain/native";
// [F94 §3.2/§3.3] the two buttons the operator reported as dead.
import { openWebDesktop } from "@/lib/openWebDesktop";
// [F95 §3.3 / R3] the manual WEB DESKTOP assertion the blocked banner was missing.
import { readManualWebDesktop, setManualWebDesktop } from "@/lib/launchUrl";
import { useNow } from "@/lib/useNow";

export function PrimaryActions() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const nativeLost = useSessionStore((s) => s.nativeLost);
  const fqdn = useSessionStore((s) => s.fqdn);
  const user = useSessionStore((s) => s.user);
  const listenerOkFlag = useSessionStore((s) => s.listenerOkFlag);
  const runnerDnsOk = useSessionStore((s) => s.runnerDnsOk);
  const autoLogin = useSessionStore((s) => s.autoLogin);
  const fireAutoLogin = useSessionStore((s) => s.fireAutoLogin);
  const fireFixReconnect = useSessionStore((s) => s.fireFixReconnect);
  const progress = useTelemetryStore((s) => s.progress);
  const runStartedAtMs = useTelemetryStore((s) => s.runStartedAtMs);
  const sessionExpired = useTelemetryStore((s) => s.sessionExpired);
  const setSessionExpired = useTelemetryStore((s) => s.setSessionExpired);
  // [F94 §3.2] non-empty when the browser blocked the WEB DESKTOP popup; the
  // URL is then rendered on the page so the operator can still get there.
  const [webdeskBlocked, setWebdeskBlocked] = useState("");
  // [F95 §3.3 / R3] epoch-ms stamp of the operator's "I opened it manually"
  // assertion. Non-empty => the badge reads WEB DESKTOP (manual).
  const [manualAsserted, setManualAsserted] = useState(() => readManualWebDesktop());
  useNow(1000);

  const s = native || {};
  const rl = s.rdpListener || null;
  const probeReasons = s.probeReasons || {};
  const credOkLocal = validFqdnUser(fqdn, user);

  const certBound = !!s.certBound;
  const nlaOn = !!s.nlaOn;
  const cs = credsspChip(rl);
  const certDays = certDaysRemaining(s.certNotAfter);
  const certTone = certDays == null ? "neutral" : certDays < 7 ? "danger" : certDays < 30 ? "warning" : "success";

  const webdeskUrl = validWebdeskUrl(s.webdeskUrl);

  // Auto-login gate: valid fqdn+user AND listener all green AND runner DNS ok.
  const autoOk = credOkLocal && listenerOkFlag && runnerDnsOk;
  const autoNote = autoOk
    ? "fullscreen native mstsc via one-time ticket; Windows prompts for your password (cmdkey) only if redemption fails"
    : !runnerDnsOk
      ? "Runner DNS broken"
      : credOkLocal
        ? "RDP LISTENER probe not all green (listening/fw/cert/nla) - fix the failed field in the RDP LISTENER row; AUTO-LOGIN stays disabled"
        : "fullscreen native mstsc via one-time ticket; Windows prompts for your password (cmdkey) only if redemption fails";

  // [F94 §3.3] WHY is AUTO-LOGIN dead? The operator reported a button that did
  // not respond to clicks: it was `disabled`, and a disabled <button> swallows
  // the click entirely - no hover reason, no tooltip, no toast. Every failing
  // gate is now named (this is the tooltip AND the on-page diagnostic), so a
  // dead button always says which gate killed it.
  const autoBlockers: string[] = [];
  if (!credOkLocal) autoBlockers.push(t("autoLoginBlocked.credentials"));
  if (!runnerDnsOk) autoBlockers.push(t("autoLoginBlocked.dns"));
  if (!listenerOkFlag) autoBlockers.push(t("autoLoginBlocked.listener"));
  const autoWhy = autoBlockers.join("; ");
  const autoTitle = autoOk ? autoNote : t("autoLoginBlocked.title") + " " + autoWhy;

  // Session-expired banner (F34 window).
  if (runStartedAtMs) {
    const expired = remainingSec(runStartedAtMs, Date.now()) <= 0;
    if (expired !== sessionExpired) setSessionExpired(expired);
  }

  const rec = recoveryDecision((rl && rl.authLast) || null, s.handlerChain || [], Date.now());
  const fixVisible = rec.show;
  const fixEnabled = validFqdnUser(fqdn, user);

  const egressIp = s.runnerEgressIp || progress?.runnerEgressIp || "";

  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold leading-tight text-primary">{t("app.title")}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Chip id="rdpFqdn" mono tone={FQDN_RE.test(fqdn) ? "accent" : "danger"} title="Target FQDN">
              {fqdn || "(not set)"}
            </Chip>
            <Chip id="nrCert" tone={certTone} title="RDP-Tcp SSLCertificateSHA1Hash present (from /api/native-status)">
              cert: {certBound ? "yes" : "NO"}
            </Chip>
            <Chip id="nrNla" tone={nlaOn ? "success" : "danger"} title="UserAuthentication == 1 on the RDP-Tcp listener">
              nla: {nlaOn ? "ON" : "OFF"}
            </Chip>
            <Chip id="nrCredssp" tone={cs.tone === "ok" ? "success" : cs.tone === "warn" ? "warning" : cs.tone === "bad" ? "danger" : "neutral"}>
              credssp: {cs.text}
            </Chip>
          </div>
          <div className="mt-1 flex flex-col gap-0.5 text-xs text-tertiary">
            <span id="nrCertReason" className={certBound ? "hidden" : ""}>{certBound ? "" : "BLOCKED: " + (probeReasons.cert || "RDP-Tcp SSLCertificateSHA1Hash absent")}</span>
            <span id="nrNlaReason" className={nlaOn ? "hidden" : ""}>{nlaOn ? "" : "BLOCKED: " + (probeReasons.nla || "UserAuthentication != 1 on the RDP-Tcp listener")}</span>
            <span id="nrCredsspReason" className={cs.tone === "ok" ? "hidden" : ""}>{cs.tone === "ok" ? "" : "BLOCKED: " + (rl && rl.credsspLive === "warn" ? "LIVE PROBE WARN: " + (rl.credsspLiveWhy || "") : rl && rl.credsspWhy ? rl.credsspWhy : "")}</span>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
          <Button
            id="btnWinAuto"
            variant="primary"
            size="lg"
            disabled={!autoOk}
            icon={<Monitor className="size-4" aria-hidden />}
            onClick={() => void fireAutoLogin()}
            aria-disabled={!autoOk}
            title={autoTitle}
            data-why={autoWhy || undefined}
          >
            {t("actions.autoLogin")}
          </Button>
          <Button
            id="btnWebDesk"
            variant="outline"
            size="lg"
            disabled={!webdeskUrl}
            icon={<Globe className="size-4" aria-hidden />}
            onClick={() => {
              if (!webdeskUrl) return;
              // [F94 §3.2] the old handler was a bare window.open() whose null
              // (popup-blocked) return was discarded: click, nothing, silence.
              const out = openWebDesktop(webdeskUrl);
              setWebdeskBlocked(!out.opened ? webdeskUrl : "");
            }}
            title={webdeskUrl || t("logonGate.noUrl")}
          >
            {t("actions.webDesktop")}
          </Button>
          <Button
            id="btnFixReconnect"
            variant="danger"
            size="lg"
            disabled={!fixEnabled}
            style={fixVisible ? undefined : { display: "none" }}
            icon={<RefreshCw className="size-4" aria-hidden />}
            onClick={() => void fireFixReconnect()}
          >
            {t("actions.fixReconnect")}
          </Button>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-1 text-xs text-secondary">
        <span id="winAutoNote">{autoLogin.note || autoNote}</span>
        {/* [F94 §3.3] AUTO-LOGIN is a disabled button when any gate fails, and a
            disabled button cannot explain itself. This line always says which
            gate failed, so the operator never has to guess why it is dead. */}
        {!autoOk ? (
          <span id="f94.autoLoginBlocked" data-testid="auto-login-blocked" role="status" className="text-warning">
            {t("autoLoginBlocked.title")} {autoWhy}
          </span>
        ) : null}
        <span id="autoLoginStatus" className="text-tertiary">{autoLogin.helloSeen ? "launcher beacon received" : ""}</span>
      </div>

      {/* [F94 §3.2] Popup-blocked fallback for the WEB DESKTOP button. */}
      {webdeskBlocked ? (
        <div
          id="f94.webdeskBlocked"
          data-testid="webdesk-blocked"
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2"
        >
          <AlertTriangle className="size-3.5 text-warning shrink-0" aria-hidden />
          <span className="text-xs font-medium text-warning">{t("webdeskBlocked.title")}</span>
          <span className="text-xs text-secondary">{t("webdeskBlocked.message")}</span>
          <a
            id="f94.webdeskBlockedLink"
            data-testid="webdesk-blocked-link"
            href={webdeskBlocked}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-accent underline break-all"
          >
            <ExternalLink className="size-3" aria-hidden />
            {webdeskBlocked}
          </a>
          <button
            type="button"
            id="f95.webdeskManual"
            data-testid="webdesk-blocked-manual"
            onClick={() => {
              // [F95 §3.3 / R3] The operator opened noVNC by hand. Record it:
              // the badge flips to "WEB DESKTOP (manual)" and stays there until
              // they say otherwise, instead of reading "Tailscale local" for
              // the rest of the run.
              setManualWebDesktop(true);
              setManualAsserted(readManualWebDesktop());
              setWebdeskBlocked("");
            }}
            className="px-2 py-0.5 text-xs rounded border border-accent/60 text-accent font-medium hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("webdeskBlocked.manualOpened")}
          </button>
          <button
            type="button"
            id="f94.webdeskRetry"
            data-testid="webdesk-blocked-retry"
            onClick={() => setWebdeskBlocked("")}
            className="px-2 py-0.5 text-xs rounded border border-default text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("webdeskBlocked.retry")}
          </button>
        </div>
      ) : null}

      {/* [F95 §3.3 / R3] ALWAYS-VISIBLE manual WEB DESKTOP toggle. It is not
          gated on the popup having been blocked: the operator may have reached
          noVNC through a bookmark, a second monitor or a plain reload, in which
          case no banner ever appears and there was previously no way at all to
          tell the dashboard. One click asserts the mode, one click withdraws it. */}
      <div
        id="f95.viewingModeToggle"
        data-testid="viewing-mode-toggle"
        className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-default bg-surface px-3 py-1.5"
      >
        <span className="text-xs text-tertiary">{t("viewingMode.manual.prefix")}</span>
        <button
          type="button"
          id="f95.viewingModeToggleBtn"
          data-testid="viewing-mode-toggle-btn"
          aria-pressed={!!manualAsserted}
          onClick={() => {
            const stamp = setManualWebDesktop(!manualAsserted);
            setManualAsserted(stamp);
          }}
          className={
            "px-2 py-0.5 text-xs rounded border font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
            (manualAsserted
              ? "border-accent/60 text-accent bg-accent/10"
              : "border-default text-secondary hover:bg-raised")
          }
        >
          {manualAsserted ? t("viewingMode.manual.on") : t("viewingMode.manual.off")}
        </button>
        {manualAsserted ? (
          <span id="f95.viewingModeManualStamp" data-testid="viewing-mode-manual-stamp" className="text-xs text-tertiary">
            {t("viewingMode.manual.since")} {new Date(Number(manualAsserted)).toLocaleTimeString()}
          </span>
        ) : (
          <span className="text-xs text-tertiary">{t("viewingMode.manual.hint")}</span>
        )}
      </div>

      {/* F28 recovery row - shown only on the correlated wrong-password failure */}
      <div
        id="recoveryRow"
        className={cn("mt-3 rounded-lg border border-danger/40 bg-danger/5 p-3 flex-col gap-2", fixVisible ? "flex" : "hidden")}
        style={fixVisible ? { display: "flex" } : undefined}
      >
        <span className="text-sm font-semibold text-danger">{t("banners.recoveryTitle")}</span>
        <span id="recoveryText" className="text-xs text-secondary">
          {fixVisible
            ? "Password rejected by the host (wrong-password sub-status 0xC000006A, " +
              (rec.dtSec !== undefined && rec.dtSec >= 0 ? rec.dtSec + "s after the last mstsc launch" : rec.dtSec !== undefined ? Math.abs(rec.dtSec) + "s before the last mstsc launch" : "") +
              "). One click re-issues a fresh ticket and overwrites the stored credential - no typing, no clipboard."
            : ""}
        </span>
        <span id="recoveryNote" className="text-xs text-tertiary">
          {t("banners.recoveryNote")}
        </span>
        <span className="flex items-center gap-2 text-xs">
          <code id="recoveryCmdkey" className="font-mono text-xs bg-sunken border border-default rounded px-2 py-1">
            {"cmdkey /generic:TERMSRV/" + (fqdn || "<fqdn>") + " /user:" + (user || "<user>") + " /pass"}
          </code>
          <CopyLink value={() => "cmdkey /generic:TERMSRV/" + fqdn + " /user:" + user + " /pass"} />
        </span>
      </div>

      {/* Banners: connBanner visibility mirrors the v1 lostCount>=2 contract */}
      <div
        id="connBanner"
        className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        role="alert"
        style={nativeLost ? undefined : { display: "none" }}
      >
        {t("errors.connLost")}
      </div>
      <div id="egressLine" className="mt-2 rounded-md border border-default bg-surface px-3 py-2 text-xs text-secondary flex items-center gap-2">
        <StatusDot tone="accent" />
        {t("egress.line", { ip: egressIp || "..." })}
      </div>
      <div id="endedBanner" className={cn("mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger flex items-center gap-2", sessionExpired ? "" : "hidden")}>
        <AlertTriangle className="size-4" aria-hidden />
        {t("banners.ended")}
      </div>

      {/* guidance view models are rendered by WebDesktopCard (ids live there) */}
    </header>
  );
}

function remainingSec(runStartedAtMs: number, now: number): number {
  return SESSION_WINDOW_MS / 1000 - Math.max(0, (now - runStartedAtMs) / 1000);
}

function certDaysRemaining(notAfter: unknown): number | null {
  if (!notAfter) return null;
  const t = Date.parse(String(notAfter));
  if (isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86400000);
}
