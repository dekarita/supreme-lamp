// [F56-c v2] Own-credential modal (URL import → "login required"). UI ONLY:
// the fields, the F46 per-run notice and the stub submit. Nothing is sent and
// nothing is persisted - no localStorage/sessionStorage write anywhere, the
// password is state-only and is wiped on close AND on stub submit (session-end
// wipe); F56-d owns the encrypted per-run submission.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { requestFetchStub } from "@/lib/fetchStub";
import { useToastStore } from "@/stores/toastStore";

export function OwnCredentialModal() {
  const { t } = useTranslation();
  const open = useSearchUiStore((s) => s.credModalOpen);
  const cred = useSearchUiStore((s) => s.cred);
  const credError = useSearchUiStore((s) => s.credError);
  const closeCredModal = useSearchUiStore((s) => s.closeCredModal);
  const setCredUser = useSearchUiStore((s) => s.setCredUser);
  const setCredPassword = useSearchUiStore((s) => s.setCredPassword);
  const setCredError = useSearchUiStore((s) => s.setCredError);
  const push = useToastStore((s) => s.push);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCredModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeCredModal]);

  if (!open) return null;

  const submit = () => {
    if (!cred.user.trim()) {
      setCredError(t("search.v2.cred.error.user"));
      return;
    }
    if (!cred.password) {
      setCredError(t("search.v2.cred.error.password"));
      return;
    }
    // Stub: no request is constructed (F56-d owns the encrypted per-run key).
    requestFetchStub({ resultId: "own-credential" });
    setCredError("");
    push(t("search.v2.credStub"), "warn");
    // Session-end wipe, immediately: the typed password leaves memory here.
    setCredPassword("");
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={closeCredModal}>
      <div
        id="f56.search.v2.credModal"
        role="dialog"
        aria-modal="true"
        aria-label={t("search.v2.cred.title")}
        data-testid="own-credential-modal"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-default rounded-md shadow-md max-w-md w-full p-4 flex flex-col gap-3"
      >
        <h3 className="text-sm font-semibold text-primary">{t("search.v2.cred.title")}</h3>
        <p id="f56.search.v2.credHost" data-testid="cred-host" className="text-xs text-secondary font-mono">
          {t("search.v2.cred.host", { host: cred.host || "—" })}
        </p>

        <label htmlFor="f56.search.v2.credUser" className="text-xs text-secondary">
          {t("search.v2.cred.user")}
        </label>
        <input
          id="f56.search.v2.credUser"
          data-testid="cred-user"
          ref={firstFieldRef}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={cred.user}
          onChange={(e) => setCredUser(e.target.value)}
          className="h-11 px-3 rounded-md border border-default bg-base text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />

        <label htmlFor="f56.search.v2.credPassword" className="text-xs text-secondary">
          {t("search.v2.cred.password")}
        </label>
        <input
          id="f56.search.v2.credPassword"
          data-testid="cred-password"
          type="password"
          autoComplete="new-password"
          value={cred.password}
          onChange={(e) => setCredPassword(e.target.value)}
          className="h-11 px-3 rounded-md border border-default bg-base text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />

        <p id="f56.search.v2.credNotice" data-testid="cred-notice" className="text-xs text-tertiary bg-sunken rounded p-2">
          {t("search.v2.cred.notice")}
        </p>
        <p id="f56.search.v2.credStub" data-testid="cred-stub" className="text-xs text-warning">
          {t("search.v2.credStub")}
        </p>
        <p id="f56.search.v2.credError" role="alert" data-testid="cred-error" className="text-xs text-danger">
          {credError}
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="cred-submit"
            onClick={submit}
            className="h-11 px-3 rounded-md bg-accent text-accent-fg text-sm font-medium hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("search.v2.cred.submit")}
          </button>
          <button
            id="f56.search.v2.credCancel"
            type="button"
            data-testid="cred-cancel"
            onClick={closeCredModal}
            className="h-11 px-3 rounded-md border border-default text-sm text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("search.actions.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
