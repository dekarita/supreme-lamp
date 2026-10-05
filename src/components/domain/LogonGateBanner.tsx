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
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { validWebdeskUrl } from "@/lib/domain/native";

export function LogonGateBanner() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const s = native || {};
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
          onClick={() => window.open(webdeskUrl, "_blank", "noopener")}
          className="ml-auto px-2 py-1 text-xs rounded-md font-medium text-white bg-accent hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("logonGate.button")}
        </button>
      ) : (
        <span className="ml-auto text-xs text-tertiary">{t("logonGate.noUrl")}</span>
      )}
    </div>
  );
}

export default LogonGateBanner;
