// [F94 §3.1] DASHBOARD TOKEN GATE - the page says so BEFORE anything fails.
//
// WHY THIS EXISTS: eight of the operator's reported symptoms traced back to one
// missing `?key=`. Without a gate, the dashboard renders a fully populated
// shell - every card, every button - and then refuses each write individually:
// "Add site rejected: Dashboard permission missing", "RDP launcher: queue-403",
// "යම් දෝෂයක් සිදු විය". A page that looks healthy and refuses everything is
// worse than a page that says what is wrong.
//
// This is a FULL-PAGE, BLOCKING modal (not a banner): with no token the
// dashboard cannot write, mirror, stream, launch or mint tickets, so there is
// nothing useful behind it. Two exits, both explicit:
//   * "Enter key manually" - the operator pastes the token main.yml printed;
//     on success it is persisted to localStorage so refreshes keep working.
//   * "Return to GitHub Actions" - a plain link back to the run that has the
//     real URL. Never a guess: the repo is public and the link is data-free.
//
// SAFETY: the token is a bearer credential. It is never put in a URL that this
// component builds, never logged, and never echoed back in the UI after entry
// (the input is cleared and only `dashTokenDebug()`'s SHAPE is shown).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { clearDashToken, dashTokenDebug, hasDashToken, shouldGate, storeDashToken } from "@/lib/dashToken";

const ACTIONS_URL = "https://github.com/dekarita/supreme-lamp/actions/workflows/main.yml";

export interface DashTokenGateProps {
  /** `true`/`false` force the gate on/off; `undefined` = auto (see
   *  `shouldGate()` - blocks only on the runner-served production dashboard). */
  force?: boolean;
  onUnlocked?: () => void;
}

/** Show the gate? `force` wins; otherwise the runner-served + no-token rule. */
export function gateVisible(force?: boolean, search?: string, hash?: string): boolean {
  if (force !== undefined) return force;
  if (hasDashToken(search, hash)) return false;
  return shouldGate();
}

export function DashTokenGate({ force, onUnlocked }: DashTokenGateProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(() => gateVisible(force));
  const [entering, setEntering] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  // A token can arrive late (the operator pastes ?key= and reloads, or a
  // HashRouter navigation lands with it). Re-check on every mount and whenever
  // the caller forces a state.
  useEffect(() => {
    setVisible(gateVisible(force));
  }, [force]);

  // [F94 §3.1] The gate must also notice a key that lands in the URL while the
  // page is open (deep link, back/forward) - otherwise the operator is stuck
  // behind a modal describing a problem they already fixed.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      setVisible(gateVisible(force));
    };
    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
    return () => {
      window.removeEventListener("popstate", check);
      window.removeEventListener("hashchange", check);
    };
  }, [force]);

  if (!visible) return null;

  const submit = () => {
    const v = value.trim();
    if (!v) {
      setError(t("dashToken.empty"));
      return;
    }
    if (v.length < 8) {
      setError(t("dashToken.tooShort"));
      return;
    }
    // Persist, then prove it round-tripped before unlocking: a storage area
    // that silently refuses writes must not show a false success.
    storeDashToken(v);
    if (!hasDashToken()) {
      setError(t("dashToken.storeFailed"));
      return;
    }
    setValue("");
    setError("");
    setEntering(false);
    setVisible(false);
    onUnlocked?.();
  };

  const debug = dashTokenDebug();

  return createPortal(
    <div
      id="f94.dashTokenGate"
      data-testid="dash-token-gate"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="f94.dashTokenGate.title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[color:var(--color-bg)] p-4"
    >
      <div className="max-w-lg w-full rounded-lg border border-danger/40 bg-surface p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="size-5 text-danger shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0">
            <h1 id="f94.dashTokenGate.title" className="text-base font-semibold text-primary">
              {t("dashToken.title")}
            </h1>
            <p id="f94.dashTokenGate.message" data-testid="dash-token-message" className="mt-2 text-sm text-secondary">
              {t("dashToken.message")}
            </p>
          </div>
        </div>

        <p className="mt-3 text-xs text-tertiary">
          {t("dashToken.shape", { source: debug.source, length: debug.length })}
        </p>

        {!entering ? (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              id="f94.dashTokenGate.enter"
              data-testid="dash-token-enter"
              onClick={() => setEntering(true)}
              className="px-3 py-2 text-sm rounded-md font-medium text-white bg-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("dashToken.enter")}
            </button>
            <a
              id="f94.dashTokenGate.actions"
              data-testid="dash-token-actions"
              href={ACTIONS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-default text-secondary hover:bg-raised hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t("dashToken.actions")}
            </a>
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm text-secondary" htmlFor="f94.dashTokenGate.input">
              {t("dashToken.inputLabel")}
              <input
                id="f94.dashTokenGate.input"
                data-testid="dash-token-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                placeholder={t("dashToken.placeholder")}
                className="h-11 px-3 rounded-md border border-default bg-surface font-mono text-sm text-primary placeholder:text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
            <span className="text-xs text-tertiary">{t("dashToken.inputHelp")}</span>
            {error ? (
              <span id="f94.dashTokenGate.error" data-testid="dash-token-error" role="alert" className="text-xs text-danger">
                {error}
              </span>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                id="f94.dashTokenGate.save"
                data-testid="dash-token-save"
                onClick={submit}
                className="px-3 py-2 text-sm rounded-md font-medium text-white bg-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {t("dashToken.save")}
              </button>
              <button
                type="button"
                id="f94.dashTokenGate.cancel"
                data-testid="dash-token-cancel"
                onClick={() => {
                  setEntering(false);
                  setValue("");
                  setError("");
                }}
                className="px-3 py-2 text-sm rounded-md border border-default text-primary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {t("dashToken.cancel")}
              </button>
            </div>
          </div>
        )}

        {/* The "wrong key" escape hatch: a bad token stored earlier would
            otherwise lock the operator out of the page that lets them fix it. */}
        <button
          type="button"
          id="f94.dashTokenGate.forget"
          data-testid="dash-token-forget"
          onClick={() => {
            clearDashToken();
            setValue("");
            setError("");
            setEntering(true);
          }}
          className="mt-4 text-xs text-tertiary underline hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          {t("dashToken.forget")}
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default DashTokenGate;
