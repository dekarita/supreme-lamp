// [F78 §2.1] "+ Add site" quick-add modal.
//
// Two fields only: Name (required, 50 char cap) and Base URL (HTTPS required).
// Category and Allowed domains are DERIVED, never typed: category is the F56
// 'software' bucket behind the operator-facing "Custom" label, and the allowed
// domain list is exactly the baseUrl hostname (exact-host equality - the same
// fence the F58 loader and the server use; no suffix matching, no wildcards).
//
// Refused before any network call: a non-HTTPS URL, a URL carrying userinfo
// (`https://user:pass@host` - credentials never belong in a URL), an empty or
// over-long name. The server re-validates every one of these; this modal only
// makes the refusal immediate and visible.
//
// [F81 §4.1/Q9] Per-field inline errors: the server now returns
// `{ errors: { name, url } }` on 400. The modal maps each error key to the
// matching field and renders red text directly below the failing input,
// clearing the field's error on every keystroke. The generic toast is
// reserved for unmapped errors.
//
// [F81 §5.0/Q10] Max 50 sites: when the store reports `labSources.length >=
// 50`, the Save button is disabled and a hint shows why.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { NEW_SITE_NAME_MAX, validateNewSite, type NewSiteError } from "@/api/lab";
import F58 from "@/search/custom-source-core";
import { MAX_CUSTOM_SITES, useCustomSourcesStore } from "@/stores/customSourcesStore";
import { useToastStore } from "@/stores/toastStore";

const ERROR_KEYS: Record<NewSiteError, string> = {
  "name-required": "newSiteNameRequired",
  "name-too-long": "newSiteNameTooLong",
  "https-required": "newSiteHttpsRequired",
  "auth-not-allowed": "newSiteAuthNotAllowed",
  network: "search.errors.generic",
};

export interface AddSiteQuickProps {
  open: boolean;
  onClose: () => void;
}

export function AddSiteQuick({ open, onClose }: AddSiteQuickProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const addSite = useCustomSourcesStore((s) => s.addSite);
  const labCount = useCustomSourcesStore((s) => s.labSources.length);
  const push = useToastStore((s) => s.push);

  // Fresh fields every time the modal opens (no half-typed carry-over).
  useEffect(() => {
    if (!open) return;
    setName("");
    setUrl("");
    setNameError(null);
    setUrlError(null);
    setGenericError(null);
    setSaving(false);
    const id = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Derived preview: what the server will store (category + exact host fence).
  const hostname = F58.hostnameFor(url.trim());
  const atCap = labCount >= MAX_CUSTOM_SITES;

  const save = async () => {
    if (saving) return;
    // Local validation first so the modal never sends a request the server
    // would reject; the server response still drives the inline messages in
    // case a remote-only rule changes later.
    const invalid = validateNewSite(name, url);
    if (invalid) {
      const key = ERROR_KEYS[invalid];
      if (invalid === "name-required" || invalid === "name-too-long") {
        setNameError(key);
        setUrlError(null);
      } else {
        setUrlError(key);
        setNameError(null);
      }
      return;
    }
    setSaving(true);
    const outcome = await addSite(name, url);
    setSaving(false);
    if (!outcome.ok) {
      const err = String(outcome.error || "search.errors.generic");
      if (err === "newSiteNameRequired" || err === "newSiteNameTooLong") {
        setNameError(err);
        setUrlError(null);
        setGenericError(null);
      } else if (
        err === "newSiteHttpsRequired" ||
        err === "newSiteAuthNotAllowed" ||
        err === "newSiteMaxReached"
      ) {
        setUrlError(err);
        setNameError(null);
        setGenericError(null);
      } else {
        setGenericError(err);
        setNameError(null);
        setUrlError(null);
      }
      return;
    }
    push(t("newSiteSuccess", { hostname: outcome.source?.hostname || hostname }));
    onClose();
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        id="f78.addSite.modal"
        data-testid="add-site-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f78.addSite.title"
        className="relative bg-surface border border-default rounded-lg shadow-md max-w-md w-full p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="f78.addSite.title" className="text-base font-semibold text-primary">
            {t("search.addSite")}
          </h2>
          <button
            type="button"
            id="f78.addSite.cancelX"
            aria-label={t("newSiteCancel")}
            onClick={onClose}
            className="text-tertiary hover:text-primary focus-visible:ring-2 focus-visible:ring-accent rounded"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-secondary" htmlFor="f78.addSite.name">
            {t("newSiteName")}
            <input
              ref={nameRef}
              id="f78.addSite.name"
              data-testid="add-site-name"
              type="text"
              maxLength={NEW_SITE_NAME_MAX}
              value={name}
              aria-invalid={nameError ? "true" : "false"}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              className={"h-11 px-3 rounded-md border bg-surface text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " + (nameError ? "border-danger" : "border-default")}
            />
            {nameError ? (
              <span id="f78.addSite.nameError" data-testid="add-site-name-error" role="alert" className="text-xs text-danger">
                {t(nameError)}
              </span>
            ) : null}
            {/* [F81 §4.1/Q9] Backwards-compat generic error testid, see below. */}
            {nameError && !urlError ? (
              <span data-testid="add-site-error" role="alert" className="sr-only">
                {t(nameError)}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1 text-sm text-secondary" htmlFor="f78.addSite.url">
            {t("newSiteUrl")}
            <input
              id="f78.addSite.url"
              data-testid="add-site-url"
              type="url"
              inputMode="url"
              placeholder="https://"
              value={url}
              aria-invalid={urlError ? "true" : "false"}
              onChange={(e) => {
                setUrl(e.target.value);
                setUrlError(null);
              }}
              className={"h-11 px-3 rounded-md border bg-surface font-mono text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " + (urlError ? "border-danger" : "border-default")}
            />
            {urlError ? (
              <span id="f78.addSite.urlError" data-testid="add-site-url-error" role="alert" className="text-xs text-danger">
                {t(urlError)}
              </span>
            ) : null}
            {/* [F81 §4.1/Q9] Backwards-compat generic error: F78 tests look for
                the `add-site-error` testid on inline failures. We keep that
                testid on whichever inline error is active so the existing
                suite (and the modal's accessibility role="alert") keep
                working while the per-field spans carry the new ids. */}
            {urlError ? (
              <span data-testid="add-site-error" role="alert" className="sr-only">
                {t(urlError)}
              </span>
            ) : null}
          </label>

          {/* Auto-filled, not operator-typed (Category + exact-host allowlist). */}
          <p id="f78.addSite.derived" data-testid="add-site-derived" className="text-xs text-tertiary">
            {t("search.registry.preset.custom")}: {hostname || "—"}
          </p>

          {atCap ? (
            <p id="f78.addSite.atCap" data-testid="add-site-at-cap" role="alert" className="text-xs text-warning">
              {t("newSiteMaxReached")}
            </p>
          ) : null}

          {genericError ? (
            <p id="f78.addSite.error" data-testid="add-site-error" role="alert" className="text-xs text-danger bg-danger/10 rounded p-2">
              {t(genericError)}
            </p>
          ) : null}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              id="f78.addSite.cancel"
              data-testid="add-site-cancel"
              onClick={onClose}
              className="px-3 py-2 text-sm rounded-md border border-default bg-surface text-primary hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("newSiteCancel")}
            </button>
            <button
              type="button"
              id="f78.addSite.save"
              data-testid="add-site-save"
              disabled={saving || atCap}
              onClick={() => void save()}
              className="px-3 py-2 text-sm rounded-md font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("newSiteSave")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default AddSiteQuick;