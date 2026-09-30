// [F58 §2] The canonical registry surface content: the source list with the
// per-source status row (reachable + robots-ok + rate-limit + last error), the
// pause/resume affordance and the REMOVE flow - a confirmation modal that names
// the source and echoes its last-active timestamp, and a store-side refusal when
// that confirmation does not match (§2 "confirmation modal with source name +
// last-active timestamp").
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/primitives/Feedback";
import { customSources, type CustomSourceStore, type SourceEntry } from "@/search/custom-source-store";

export interface SourceRegistryListProps {
  store?: CustomSourceStore;
  onEdit?: (id: string) => void;
}

export function SourceRegistryList({ store = customSources, onEdit }: SourceRegistryListProps) {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  const [confirm, setConfirm] = useState<SourceEntry | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => store.subscribe(() => setTick((n) => n + 1)), [store]);

  const entries = store.entries();
  const confirmKey = (e: SourceEntry) => String(e.descriptor.nameKey) + "|" + String(e.descriptor.baseUrl);

  const doRemove = useCallback(
    (entry: SourceEntry | null) => {
      if (!entry) return "";
      const res = store.remove(String(entry.descriptor.id), { name: confirmKey(entry), lastActiveAt: entry.status.lastActiveAt });
      setMessage(res.ok ? t("search.registry.removed", { id: String(entry.descriptor.id) }) : t("search.registry.removeRefused", { reason: res.reason || "unknown" }));
      setConfirm(null);
      if (res.ok) void store.persist();
      return "";
    },
    [store, t]
  );

  if (!entries.length) {
    return (
      <p data-testid="source-registry-empty" className="text-xs text-tertiary">
        {t("search.registry.list.empty")}
      </p>
    );
  }

  return (
    <div data-testid="source-registry-list" data-tick={tick} className="flex flex-col gap-2">
      {entries.map((e) => {
        const id = String(e.descriptor.id);
        const paused = e.f58.enableState === "paused";
        return (
          <div key={id} data-testid={"source-registry-row-" + id} className="rounded border border-default bg-surface p-2 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs">
              <span data-testid={"source-registry-name-" + id} className="font-semibold text-primary truncate">
                {id}
              </span>
              <span data-testid={"source-registry-state-" + id} className={"rounded px-2 py-0.5 text-xs " + (paused ? "text-warning" : "text-success")}>
                {paused ? t("search.registry.state.paused") : t("search.registry.state.permanent")}
              </span>
              <span data-testid={"source-registry-pinned-" + id} className="text-xs font-mono text-tertiary">
                {e.parseContractPinned ? t("search.registry.contract.pinned") : t("search.registry.contract.unpinned")}
              </span>
              {store.isReadOnly() ? <span data-testid="source-registry-readonly" className="text-xs text-warning">{t("search.registry.readonly")}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-secondary">
              <span data-testid={"source-registry-reachable-" + id}>{t("search.registry.status.reachable")}: {fmt(e.status.reachable)}</span>
              <span data-testid={"source-registry-robots-" + id}>{t("search.registry.status.robotsOk")}: {fmt(e.status.robotsOk)}</span>
              <span data-testid={"source-registry-ratelimit-" + id}>{t("search.registry.status.rateLimit")}: {e.status.rateLimitedHits}</span>
              <span data-testid={"source-registry-error-" + id} className="text-danger truncate">
                {t("search.registry.status.lastError")}: {e.status.lastError || t("search.registry.status.none")}
              </span>
              <span data-testid={"source-registry-active-" + id} className="font-mono text-tertiary">
                {t("search.registry.status.lastActive")}: {e.status.lastActiveAt || t("search.registry.status.never")}
              </span>
            </div>
            {e.status.fetchDisabledReason ? (
              <p data-testid={"source-registry-fetch-disabled-" + id} className="text-xs text-danger">
                {t("search.registry.status.fetchDisabled", { reason: e.status.fetchDisabledReason })}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <button type="button" data-testid={"source-registry-edit-" + id} onClick={() => onEdit && onEdit(id)} className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised">
                {t("search.registry.edit")}
              </button>
              <button
                type="button"
                data-testid={"source-registry-toggle-" + id}
                onClick={() => {
                  const res = paused ? store.resume(id) : store.pause(id);
                  setMessage(res.ok ? "" : res.reason || "refused");
                  if (res.ok) void store.persist();
                }}
                className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised"
              >
                {paused ? t("search.registry.resume") : t("search.registry.pause")}
              </button>
              <button type="button" data-testid={"source-registry-remove-" + id} onClick={() => setConfirm(e)} className="h-11 px-3 rounded-md border border-default text-xs text-danger hover:bg-raised">
                {t("search.registry.remove.label")}
              </button>
              {message ? <span data-testid="source-registry-message" className="text-xs text-tertiary">{message}</span> : null}
            </div>
          </div>
        );
      })}

      <Modal
        open={confirm !== null}
        title={t("search.registry.remove.confirm.title")}
        description={
          confirm ? (
            <span data-testid="source-registry-remove-detail" className="text-xs text-secondary">
              {t("search.registry.remove.confirm.body", { name: String(confirm.descriptor.id), lastActiveAt: confirm.status.lastActiveAt || t("search.registry.status.never") })}
            </span>
          ) : null
        }
        onClose={() => setConfirm(null)}
        primary={{ label: t("search.registry.remove.label"), onClick: () => void doRemove(confirm), variant: "danger" }}
        secondary={{ label: t("search.actions.cancel"), onClick: () => setConfirm(null) }}
      />
    </div>
  );
}

function fmt(v: boolean | null): string {
  return v === null ? "—" : v ? "yes" : "no";
}
