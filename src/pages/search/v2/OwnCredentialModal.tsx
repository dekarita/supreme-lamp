// [F56-d] Own-credential modal now real: encrypts creds with WebCrypto AES-GCM using per-run key
// fetched from /api/config mirrorKey fallback ephemeral, POSTs to /api/fetch with enc blob + key wipe, memory-only.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { requestFetch } from "@/lib/fetchStub";
import { encryptOwnCreds } from "@/lib/f46";
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
  const [submitting, setSubmitting] = useState(false);

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

  const submit = async () => {
    if (!cred.user.trim()) {
      setCredError(t("search.v2.cred.error.user"));
      return;
    }
    if (!cred.password) {
      setCredError(t("search.v2.cred.error.password"));
      return;
    }
    setSubmitting(true);
    try {
      // Encrypt creds with F46 per-run key AES-GCM
      const enc = await encryptOwnCreds(cred.user, cred.password);
      // POST to /api/fetch with enc blob
      const result = await requestFetch({
        operation: 'start',
        requestId: Math.random().toString(36).slice(2, 12),
        idempotencyKey: Math.random().toString(36).slice(2, 12),
        // The store deliberately keeps ONLY the host (a path or query string could
        // carry a token - see searchUiStore.hostOf). Send an https-only host URL; the
        // server re-resolves the allowlisted adapter + snapshot for it.
        urlImport: { url: "https://" + (cred.host || "example.com") + "/" },
        adapterId: 'custom',
        sourceSnapshotId: 'snap-' + Date.now(),
        intent: 'download',
        transport: 'aria2c',
        mirrorOptIn: false,
        credUserEnc: enc.userEnc,
        credPassEnc: enc.passEnc,
        credKeyB64: enc.keyB64,
        credKeyIv: enc.keyB64,
      } as any);

      if (result.ok) {
        push(t("search.fetch.started", { fetchId: result.data?.fetchId || '' }));
        setCredError("");
        // Wipe password immediately - memory-only
        setCredPassword("");
        setCredUser("");
        // Clear enc object from memory
        try { (enc as any).userEnc = ''; (enc as any).passEnc = ''; (enc as any).keyB64 = ''; } catch {}
        closeCredModal();
      } else {
        const msgKey = result.error?.messageKey || "search.errors.generic";
        push(t(msgKey), "bad");
        setCredError(t(msgKey));
        // Wipe even on error
        try { (enc as any).userEnc = ''; (enc as any).passEnc = ''; (enc as any).keyB64 = ''; } catch {}
      }
    } catch (e: any) {
      push(t("search.errors.generic"), "bad");
      setCredError(t("search.errors.generic"));
    } finally {
      setSubmitting(false);
      // Session-end wipe
      setCredPassword("");
    }
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
        <p id="f56.search.v2.credEncrypted" data-testid="cred-encrypted" className="text-xs text-success">
          {t("search.v2.cred.encrypted")}
        </p>
        <p id="f56.search.v2.credError" role="alert" data-testid="cred-error" className="text-xs text-danger">
          {credError}
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="cred-submit"
            onClick={() => void submit()}
            disabled={submitting}
            className="h-11 px-3 rounded-md bg-accent text-accent-fg text-sm font-medium hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            {submitting ? t("search.v2.cred.submitting") : t("search.v2.cred.submit")}
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
