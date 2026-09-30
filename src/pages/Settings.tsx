// [F41 plan §5.7] Settings page: install kit (InstallGuide), appearance
// (theme/scale/language mirroring the TopBar toggles), migration notes table
// (F38 -> v2 id policy).
// [F58 §2] Canonical CUSTOM SOURCE REGISTRY surface: the "Search sources" card
// holds the operator source list (list + add + edit + pause + remove, with the
// per-source reachable/robots/rate-limit/last-error status row) and mounts the
// SAME shared SourceForm the search AdvancedPanel mounts - one component, one
// store (src/search/custom-source-store.ts), two mount points.
import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SourceForm } from "@/components/search/SourceForm";
import { SourceRegistryList } from "@/components/search/SourceRegistryList";
import { Card } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { Toggle, Chip } from "@/components/primitives/Chip";
import { InstallGuide } from "@/components/domain/InstallGuide";
import { useThemeStore, useScaleStore, useLangStore, type TextScale } from "@/stores/prefsStore";

const SCALES: TextScale[] = ["comfort", "large", "a11y"];

export default function Settings() {
  const { t } = useTranslation();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const scale = useScaleStore((s) => s.scale);
  const setScale = useScaleStore((s) => s.setScale);
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);
  // [F58 §2] editId drives the shared form into edit mode on the canonical surface.
  const [editId, setEditId] = useState<string | null>(null);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <SettingsIcon className="size-5 text-accent" aria-hidden />
        <h2 className="text-xl font-semibold">{t("pages.settings.title")}</h2>
      </div>

      <Card title={t("pages.settings.appearance")} className="mb-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium w-40">{t("pages.settings.theme")}</span>
            <Button variant={theme === "dark" ? "primary" : "secondary"} size="sm" onClick={() => setTheme("dark")}>
              {t("toggle.theme.dark")}
            </Button>
            <Button variant={theme === "light" ? "primary" : "secondary"} size="sm" onClick={() => setTheme("light")}>
              {t("toggle.theme.light")}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium w-40">{t("pages.settings.textScale")}</span>
            {SCALES.map((sc) => (
              <Button key={sc} variant={scale === sc ? "primary" : "secondary"} size="sm" onClick={() => setScale(sc)}>
                {t("toggle.scale." + sc)}
              </Button>
            ))}
            <Chip tone="neutral" mono>
              html[data-scale={scale}]
            </Chip>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium w-40">{t("pages.settings.language")}</span>
            <Toggle checked={lang === "si"} onChange={(v) => setLang(v ? "si" : "en")} label={t("toggle.language.label")} />
            <span className="text-sm text-secondary">{lang === "si" ? "සිංහල" : "English"}</span>
            <Chip tone="warning">Sinhala strings marked for operator native review</Chip>
          </div>
        </div>
      </Card>

      {/* [F58 §2] CUSTOM SOURCE REGISTRY (canonical surface). Additive: nothing on
          this page changes the mirror opt-in model - the mirror stays default-OFF
          with the F51 Downloads-root override and no workflow dispatch lives here. */}
      <Card title={t("search.registry.title")} className="mb-4">
        <div className="flex flex-col gap-3">
          <SourceRegistryList onEdit={(id) => setEditId(id)} />
          <div id="f56.search.v2.sourcesFormMount.settings" data-testid="source-form-mount" className="rounded border border-default bg-base p-2">
            <SourceForm surface="settings" editId={editId} onDone={() => setEditId(null)} />
          </div>
        </div>
      </Card>

      <InstallGuide />

      <Card title={t("pages.settings.migration")} className="mb-4">
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-default text-left text-secondary">
                <th scope="col" className="px-3 py-2">contract</th>
                <th scope="col" className="px-3 py-2">v2 policy</th>
              </tr>
            </thead>
            <tbody className="text-xs text-secondary">
              <tr className="border-b border-default">
                <td className="px-3 py-2 font-mono">219 regression ids</td>
                <td className="px-3 py-2">kept verbatim (src/lib/regression-ids.ts; enforced in CI by jsdom render + static cross-check vs tests/f38-ui-glass.test.js)</td>
              </tr>
              <tr className="border-b border-default">
                <td className="px-3 py-2 font-mono">/api/* surface</td>
                <td className="px-3 py-2">unchanged: config, native-status, rdp-token, purge-stale-creds, handler-hello, progress, ping, health, flush, launch, diag</td>
              </tr>
              <tr className="border-b border-default">
                <td className="px-3 py-2 font-mono">glass UI (F38/F39)</td>
                <td className="px-3 py-2">retired: solid slate surfaces, 4/6/8px radii, 0-200ms motion; v1 reachable at /v1.html (one release)</td>
              </tr>
              <tr className="border-b border-default">
                <td className="px-3 py-2 font-mono">flag</td>
                <td className="px-3 py-2">{"v2 is the DEFAULT ($script:UiV2Default=$true); ?ui=v1 opens Classic UI for one release; missing ui-v2.html -> v1 + red banner"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {/* [F48 §4] OPERATOR SECRET HYGIENE - documented here AND in the PR body.
          The literal secret name may not exist anywhere in this repository (a
          CI gate enforces it), so the card describes the action instead. */}
      <Card title="Secret hygiene (mirror token-less mode)" className="mb-4">
        <div className="flex flex-col gap-2 text-sm text-secondary" data-testid="secret-hygiene">
          <p>
            <b className="text-primary">Secret hygiene (F48):</b> the mirror now uploads in token-less guest
            mode - no repository secret is read by any workflow, and no auth header is ever sent to the
            mirror host.
          </p>
          <ol className="list-decimal pl-5 flex flex-col gap-1">
            <li>
              Delete the former mirror-host account-token secret from repo{" "}
              <span className="font-mono text-xs">Settings &gt; Secrets and variables &gt; Actions</span> (the
              F47-era secret; its name no longer exists anywhere in this repository).
            </li>
            <li>
              Invalidate that token on the mirror host&apos;s account page - it is treated as compromised
              (it traversed sessions). Confirm both are done before the next dispatch.
            </li>
          </ol>
        </div>
      </Card>
    </div>
  );
}
