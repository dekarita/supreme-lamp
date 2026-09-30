// [F58 §2] THE shared source form. ONE component, mounted at TWO surfaces - the
// canonical "Search sources" section in Settings and the "Add source" inline card
// in the search AdvancedPanel - and BOTH instances write the SAME store instance
// (`customSources`). The form renders identically at either mount point: no
// surface-conditional markup, no duplicated field inventory, no second store.
//
// Field inventory (§2): name, category (code-hosting | vendor-download |
// public-archive | own-storage-nas), baseUrl (HTTPS only), allowedDomains[],
// queryTemplate + parseContract. The parse contract is AUTO-SUGGESTED from the
// add-time probe, confirmed by the operator and PINNED - there is no runtime
// discovery after the pin (store.proposeRuntimeParse refuses it).
//
// Nothing here fetches: the probe is an injected callback (F56-d wires the real
// one), so an unwired build says so instead of inventing a request. No credential,
// no token and no operator identity is ever held in this component.
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import F58 from "@/search/custom-source-core";
import { customSources, runAddTimeProbe, sha256Hex, type CustomSourceStore, type ProbeResult, type SourceDescriptor } from "@/search/custom-source-store";
import { applyPreset, isAllowlistPinned, listPresets } from "@/search/source-presets";

export interface SourceFormProps {
  /** Which surface mounted it - used ONLY as a data attribute for the tests. */
  surface: "settings" | "advanced";
  /** Edit target (canonical surface); omitted = add flow. */
  editId?: string | null;
  store?: CustomSourceStore;
  /** Add-time probe seam. Default = unwired (never a hidden network call). */
  probe?: (d: SourceDescriptor) => Promise<Partial<ProbeResult>>;
  onDone?: (id: string) => void;
}

const CUSTOM_PRESET = "custom";

export function SourceForm({ surface, editId = null, store = customSources, probe, onDone }: SourceFormProps) {
  const { t } = useTranslation();
  const presets = useMemo(() => listPresets(), []);
  const target = editId ? store.get(editId) : null;
  const [presetId, setPresetId] = useState<string>(target ? CUSTOM_PRESET : CUSTOM_PRESET);
  const [name, setName] = useState(target ? String(target.descriptor.nameKey) : "");
  const [category, setCategory] = useState<string>(target ? F58.CATEGORY_TO_F56["code-hosting"] : "code-hosting");
  const [baseUrl, setBaseUrl] = useState(target ? String(target.descriptor.baseUrl) : "");
  const [domains, setDomains] = useState((target ? target.descriptor.allowedDomains : []).join("\n"));
  const [method, setMethod] = useState<"GET" | "POST">((target?.descriptor.queryTemplate?.method as "GET" | "POST") || "GET");
  const [path, setPath] = useState(target ? String(target.descriptor.queryTemplate.path) : "/");
  const [format, setFormat] = useState(target ? String(target.descriptor.parseContract.format) : "json");
  const [selector, setSelector] = useState(target ? String(target.descriptor.parseContract.resultSelector) : "$.items[*]");
  const [mapping, setMapping] = useState(target ? Object.entries(target.descriptor.parseContract.fieldMappings).map(([k, v]) => k + "=" + v).join("\n") : "title=name\nsourceUrl=html_url\ndate=updated_at");
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [confirmed, setConfirmed] = useState(Boolean(target && target.parseContractPinned));
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const pinned = isAllowlistPinned(presetId);

  const parseDomains = useCallback(() => domains.split(/[\n,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean), [domains]);

  const parseMappings = useCallback(() => {
    const out: Record<string, string> = {};
    for (const line of mapping.split(/[\n,]+/)) {
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }, [mapping]);

  const buildDraft = useCallback((): { descriptor: SourceDescriptor | null; errors: string[] } => {
    const base = presetId === CUSTOM_PRESET ? null : applyPreset(presetId, { operatorId: "form", hash: sha256Hex });
    if (presetId !== CUSTOM_PRESET && (!base || !base.draft)) return { descriptor: null, errors: base ? base.errors : ["unknown preset"] };
    const descriptor: SourceDescriptor = {
      schemaVersion: base && base.draft ? base.draft.schemaVersion : "f56.1",
      id: (name || "custom-source").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom-source",
      nameKey: name || "custom-source",
      category: F58.CATEGORY_TO_F56[category] || "software",
      baseUrl: baseUrl.trim(),
      allowedDomains: parseDomains(),
      queryTemplate: {
        method,
        path: path.startsWith("/") ? path : "/" + path,
        query: base && base.draft ? base.draft.queryTemplate.query : { q: "{encodedQuery}", per_page: "{limit}", page: "{cursor}" },
        placeholders: base && base.draft ? base.draft.queryTemplate.placeholders : { encodedQuery: "q", cursor: "page", limit: "per_page" },
      },
      licenceTag: (base && base.draft ? base.draft.licenceTag : { perResult: true, allowedTags: ["open-access", "creative-commons", "purchase"] }) as SourceDescriptor["licenceTag"],
      licenceEvidence: { required: true },
      robotsCheck: { policy: "https://" + (F58.hostOf(baseUrl.trim()) || "invalid") + "/robots.txt", onDisallow: "deny" },
      rateLimit: HARD_LIMIT(),
      timeout: { connect: F58.HARD.connectTimeoutSec, request: F58.HARD.requestTimeoutSec },
      parseContract: { format, resultSelector: selector, fieldMappings: parseMappings(), pagination: "cursor:query.cursor" },
      downloadContract: { artifactFields: ["browser_download_url", "url"], contentLengthRequired: true },
      transportModes: ["https"],
      redirectPolicy: { requireHttps: true, requireAllowlisted: true },
    };
    return { descriptor, errors: [] };
  }, [name, category, baseUrl, method, path, format, selector, parseDomains, parseMappings, presetId]);

  const doProbe = useCallback(async () => {
    const { descriptor, errors: buildErrors } = buildDraft();
    if (!descriptor) { setErrors(buildErrors); return; }
    const res = await runAddTimeProbe(descriptor, probe || (async () => ({ error: "probe-backend-unwired (F56-d owns the add-time probe)" })));
    setProbeResult(res);
    if (res.suggestedParseContract) {
      setFormat(res.suggestedParseContract.format);
      setSelector(res.suggestedParseContract.resultSelector);
      setMapping(Object.entries(res.suggestedParseContract.fieldMappings).map(([k, v]) => k + "=" + v).join("\n"));
      setConfirmed(false);
    }
    setErrors(res.error ? [res.error] : []);
  }, [buildDraft, probe]);

  const save = useCallback(async () => {
    const { descriptor, errors: buildErrors } = buildDraft();
    if (!descriptor) { setErrors(buildErrors); return; }
    if (!confirmed) { setErrors([t("search.registry.probe.confirmRequired")]); return; }
    const extension = {
      addedAt: (target && target.f58.addedAt) || new Date().toISOString(),
      // §1 attribution: hash of the operator id, never the identity itself.
      source: (target && target.f58.source) || sha256Hex("operator-local"),
      enableState: (target ? target.f58.enableState : "permanent") as "permanent" | "paused",
    };
    let outcome: { ok: boolean; errors: string[] };
    if (target) {
      outcome = store.update(String(target.descriptor.id), descriptor);
    } else {
      const created = store.create(descriptor, extension);
      outcome = { ok: created.ok, errors: created.errors };
      if (created.ok && created.entry) {
        store.pinParseContract(String(created.entry.descriptor.id), descriptor.parseContract);
        await store.persist();
      }
    }
    setErrors(outcome.ok ? [] : outcome.errors);
    setSaved(outcome.ok ? String(descriptor.id) : null);
    if (outcome.ok && onDone) onDone(String(descriptor.id));
  }, [buildDraft, confirmed, onDone, store, t, target]);

  return (
    <div
      id={"f56.search.v2.sourcesForm." + surface}
      data-testid="source-form"
      data-surface={surface}
      className="w-full flex flex-col gap-2 text-left"
    >
      <p className="text-xs text-tertiary">{t("search.registry.subtitle")}</p>

      <div role="group" aria-label={t("search.registry.presets")} data-testid="source-form-presets" className="flex flex-wrap items-center gap-1.5">
        {presets.map((p) => (
          <button
            key={p.presetId}
            type="button"
            data-testid={"source-form-preset-" + p.presetId.replace(/[^a-z0-9]+/g, "-")}
            aria-pressed={presetId === p.presetId}
            onClick={() => {
              const next = p.presetId;
              setPresetId(next);
              const applied = applyPreset(next, { operatorId: "form", hash: sha256Hex });
              if (applied.draft) {
                setName(String(applied.draft.id));
                setCategory(p.formCategory);
                setBaseUrl(p.baseUrl);
                setDomains(p.allowedDomains.join("\n"));
                setPath(p.baseUrl && applied.draft.queryTemplate ? String(applied.draft.queryTemplate.path) : "/");
                setMethod((applied.draft.queryTemplate.method as "GET" | "POST") || "GET");
                setFormat(applied.draft.parseContract.format);
                setSelector(applied.draft.parseContract.resultSelector);
                setMapping(Object.entries(applied.draft.parseContract.fieldMappings).map(([k, v]) => k + "=" + v).join("\n"));
              }
            }}
            className="h-11 px-3 rounded-full border text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {p.displayName}
          </button>
        ))}
        <button
          type="button"
          data-testid="source-form-preset-custom"
          aria-pressed={presetId === CUSTOM_PRESET}
          onClick={() => setPresetId(CUSTOM_PRESET)}
          className="h-11 px-3 rounded-full border text-xs"
        >
          {t("search.registry.preset.custom")}
        </button>
      </div>

      <label htmlFor={"f56.search.v2.sourcesFormName." + surface} className="text-xs text-tertiary">{t("search.registry.field.name")}</label>
      <input
        id={"f56.search.v2.sourcesFormName." + surface}
        data-testid="source-form-name"
        className="h-11 px-2 rounded-md border border-default bg-base text-xs text-primary"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <label htmlFor={"f56.search.v2.sourcesFormCategory." + surface} className="text-xs text-tertiary">{t("search.registry.field.category")}</label>
      <select
        id={"f56.search.v2.sourcesFormCategory." + surface}
        data-testid="source-form-category"
        className="h-11 px-2 rounded-md border border-default bg-base text-xs text-primary"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        {F58.SOURCE_CATEGORIES.map((c) => (
          <option key={c} value={c}>{t("search.registry.category." + c.replace(/-([a-z])/g, (_, x: string) => x.toUpperCase()))}</option>
        ))}
      </select>

      <label htmlFor={"f56.search.v2.sourcesFormBaseUrl." + surface} className="text-xs text-tertiary">{t("search.registry.field.baseUrl")}</label>
      <input
        id={"f56.search.v2.sourcesFormBaseUrl." + surface}
        data-testid="source-form-baseurl"
        className="h-11 px-2 rounded-md border border-default bg-base text-xs font-mono text-primary"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />

      <label htmlFor={"f56.search.v2.sourcesFormDomains." + surface} className="text-xs text-tertiary">
        {t("search.registry.field.allowedDomains")}
        {pinned ? <span data-testid="source-form-allowlist-pinned" className="ml-1 text-warning">{t("search.registry.preset.pinned")}</span> : null}
      </label>
      <textarea
        id={"f56.search.v2.sourcesFormDomains." + surface}
        data-testid="source-form-domains"
        readOnly={pinned}
        rows={3}
        className="px-2 py-1 rounded-md border border-default bg-base text-xs font-mono text-primary"
        value={domains}
        onChange={(e) => setDomains(e.target.value)}
      />

      <div className="flex items-center gap-2">
        <label htmlFor={"f56.search.v2.sourcesFormMethod." + surface} className="text-xs text-tertiary">{t("search.registry.field.queryMethod")}</label>
        <select
          id={"f56.search.v2.sourcesFormMethod." + surface}
          data-testid="source-form-method"
          className="h-11 px-2 rounded-md border border-default bg-base text-xs text-primary"
          value={method}
          onChange={(e) => setMethod(e.target.value as "GET" | "POST")}
        >
          <option value="GET">GET</option>
          <option value="POST">POST</option>
        </select>
        <label htmlFor={"f56.search.v2.sourcesFormPath." + surface} className="text-xs text-tertiary">{t("search.registry.field.queryPath")}</label>
        <input
          id={"f56.search.v2.sourcesFormPath." + surface}
          data-testid="source-form-path"
          className="h-11 px-2 rounded-md border border-default bg-base text-xs font-mono text-primary"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-tertiary">{t("search.registry.field.parseContract")}</span>
        <input
          data-testid="source-form-format"
          aria-label={t("search.registry.field.parseFormat")}
          className="h-11 px-2 rounded-md border border-default bg-base text-xs font-mono text-primary"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
        />
        <input
          data-testid="source-form-selector"
          aria-label={t("search.registry.field.resultSelector")}
          className="h-11 px-2 rounded-md border border-default bg-base text-xs font-mono text-primary"
          value={selector}
          onChange={(e) => setSelector(e.target.value)}
        />
        <textarea
          data-testid="source-form-mappings"
          aria-label={t("search.registry.field.fieldMappings")}
          rows={3}
          className="px-2 py-1 rounded-md border border-default bg-base text-xs font-mono text-primary"
          value={mapping}
          onChange={(e) => setMapping(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-2" data-testid="source-form-probe">
        <button type="button" data-testid="source-form-probe-run" onClick={() => void doProbe()} className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised">
          {t("search.registry.probe.run")}
        </button>
        <span data-testid="source-form-probe-status" className="text-xs font-mono text-tertiary">
          {probeResult ? (probeResult.error || (probeResult.reachable ? t("search.registry.probe.ok") : t("search.registry.probe.unreachable"))) : t("search.registry.probe.idle")}
        </span>
        <span data-testid="source-form-probe-robots" className="text-xs text-tertiary">
          {probeResult && probeResult.robotsOk ? t("search.registry.probe.robotsOk") : t("search.registry.probe.robotsUnknown")}
        </span>
        <label className="flex items-center gap-1 text-xs text-secondary">
          <input type="checkbox" data-testid="source-form-confirm-contract" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {t("search.registry.probe.confirm")}
        </label>
      </div>

      <p data-testid="source-form-ratelimit" className="text-xs text-tertiary">
        {t("search.registry.ratelimit.note", { conc: F58.HARD.concurrency, rpm: F58.HARD.requestsPerMinute, timeout: F58.HARD.requestTimeoutSec })}
      </p>

      <ul data-testid="source-form-errors" className="flex flex-col gap-1 text-xs text-danger">
        {errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      <p data-testid="source-form-saved" className="text-xs text-success">{saved ? t("search.registry.saved", { id: saved }) : ""}</p>

      <div className="flex items-center gap-2">
        <button type="button" data-testid="source-form-save" onClick={() => void save()} className="h-11 px-3 rounded-md bg-accent text-accent-fg text-sm font-medium">
          {editId ? t("search.registry.edit") : t("search.registry.add")}
        </button>
        <span data-testid="source-form-target-store" className="text-xs font-mono text-tertiary">
          {t("search.registry.storeTarget", { count: store.entries().length })}
        </span>
      </div>
    </div>
  );
}

function HARD_LIMIT(): SourceDescriptor["rateLimit"] {
  return { requestsPerMinute: F58.HARD.requestsPerMinute, burst: F58.HARD.burst, concurrency: F58.HARD.concurrency, retryAfter: "respect-floor-120s", backoff: "jittered-exponential" };
}

export { F58 };
