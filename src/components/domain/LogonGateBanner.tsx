// [F93 §2.1] LOGON GATE BANNER - prominent, honest, on EVERY route.
//
// Why: the F92 operator report showed "LAST LOGON none yet" while the whole
// dashboard looked healthy. Nothing is logged into the RDP session, so the
// F91 launcher service (an ONLOGON task) is not running: every "Open in RDP"
// queues into a service that cannot consume the queue. The banner says that
// out loud at the top of the page, and its button opens the WEB DESKTOP URL
// (the noVNC endpoint already shown on Overview, validated by the same
// validWebdeskUrl() fence) so the operator can log in.
//
// It hides itself the moment /api/native-status reports a type-10 4624
// success - there is no dismiss button and no localStorage opt-out, so the
// banner can never lie for longer than one poll (15s).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { validWebdeskUrl } from "@/lib/domain/native";
import { openWebDesktop } from "@/lib/openWebDesktop";
// [F95 §3.3 / R3] the manual WEB DESKTOP assertion.
import { readManualWebDesktop, setManualWebDesktop } from "@/lib/launchUrl";

export function LogonGateBanner() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const s = native || {};
  // [F94 §3.2] "Open WEB DESKTOP does nothing": window.open() returns null when
  // the browser blocks the popup and the old handler threw that away, so the
  // click produced NO tab and NO error. A block now falls back to showing the
  // URL for the operator to open by hand - never a silent no-op.
  const [blocked, setBlocked] = useState(false);
  const [opened, setOpened] = useState(false);
  // [F95 §3.3 / R3] epoch-ms stamp of the operator's manual assertion.
  const [manualAsserted, setManualAsserted] = useState(() => readManualWebDesktop());
  const authLast = (s.rdpListener && s.rdpListener.authLast) || null;
  // Unknown (no scan yet) is NOT a banner: only evidence speaks. "none" and
  // "failed" both mean no RDP user is logged in.
  if (!authLast || authLast.result === "success") return null;
  const webdeskUrl = validWebdeskUrl(s.webdeskUrl);
  return (
    <div
      id="f93.logonGate.banner"
      data-testid="logon-gate-banner"
      role="alert"
      className="sticky top-12 z-30 border-b border-warning/40 bg-warning/15 px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <AlertTriangle className="size-4 text-warning shrink-0" aria-hidden />
      <span className="text-sm font-medium text-warning">
        {t("logonGate.title")}
      </span>
      <span className="text-xs text-secondary">{t("logonGate.message")}</span>
      {webdeskUrl ? (
        <button
          type="button"
          id="f93.logonGate.openWebdesk"
          data-testid="logon-gate-open-webdesk"
          onClick={() => {
            const out = openWebDesktop(webdeskUrl);
            setOpened(out.opened);
            setBlocked(!out.opened);
          }}
          className="ml-auto px-2 py-1 text-xs rounded-md font-medium text-white bg-accent hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("logonGate.button")}
        </button>
      ) : (
        <span className="ml-auto text-xs text-tertiary">{t("logonGate.noUrl")}</span>
      )}
      {/* [F94 §3.2] Popup-blocked fallback: the URL is on screen, copyable,
          and never hidden behind a button that already failed once. */}
      {blocked && webdeskUrl ? (
        <div
          id="f94.logonGate.webdeskBlocked"
          data-testid="logon-gate-webdesk-blocked"
          role="alert"
          className="w-full flex flex-wrap items-center gap-2 rounded border border-warning/40 bg-warning/10 px-2 py-1.5"
        >
          <span className="text-xs font-medium text-warning">{t("webdeskBlocked.title")}</span>
          <span className="text-xs text-secondary">{t("webdeskBlocked.message")}</span>
          <a
            id="f94.logonGate.webdeskBlockedLink"
            data-testid="logon-gate-webdesk-blocked-link"
            href={webdeskUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-accent underline break-all"
          >
            <ExternalLink className="size-3" aria-hidden />
            {webdeskUrl}
          </a>
          <span className="text-xs text-tertiary">{t("webdeskBlocked.copyHint")}</span>
          {/* [F95 §3.3 / R3] the missing manual override. Opening noVNC by hand
              used to change nothing the dashboard could see, so this banner
              stayed up and the badge stayed "Tailscale local" on a machine the
              operator was demonstrably inside. */}
          <button
            type="button"
            id="f95.logonGate.webdeskManual"
            data-testid="logon-gate-webdesk-manual"
            onClick={() => {
              setManualWebDesktop(true);
              setManualAsserted(readManualWebDesktop());
            }}
            className="px-2 py-0.5 text-xs rounded border border-accent/60 text-accent font-medium hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("webdeskBlocked.manualOpened")}
          </button>
        </div>
      ) : null}
      {opened ? (
        <span id="f94.logonGate.webdeskOpened" data-testid="logon-gate-webdesk-opened" role="status" className="sr-only">
          web-desktop-opened
        </span>
      ) : null}
      {/* [F95 §3.3 / R3] confirmation that the manual assertion took. Without
          this the click is indistinguishable from the click that did nothing. */}
      {manualAsserted ? (
        <span
          id="f95.logonGate.webdeskManualAsserted"
          data-testid="logon-gate-webdesk-manual-asserted"
          role="status"
          className="w-full text-xs text-accent"
        >
          {t("viewingMode.manual.on")} - {t("viewingMode.manual.since")}{" "}
          {new Date(Number(manualAsserted)).toLocaleTimeString()}
        </span>
      ) : null}
    </div>
  );
}

export default LogonGateBanner;
