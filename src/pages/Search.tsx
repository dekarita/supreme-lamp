// [F56-c v3] Search page - all-in-one bar landing (zero visible chips) ->
// animated to the top -> VISIBLE 5-minute lab -> result cards, with a
// DEV-only fixture fallback so the lab and grid progress without F56-d.
// The page owns composition only:
// query state lives in searchStore, view/animation/advanced/import/credential
// state in searchUiStore, the 5-minute state machine in
// src/lib/search/progressiveLab.ts, and the fetch action in the src/api/fetch
// stub (F56-d replaces that one module).
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { EmptyState, LoadingState } from "./search/SearchStates";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSearchStore, selectVisibleResults, selectFilterSelectionCount } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { CommandBar } from "./search/CommandBar";
import { AddSiteQuick } from "@/components/search/AddSiteQuick";
import { CustomSitesRow } from "@/components/search/CustomSitesRow";
import { SearchHero } from "./search/v2/SearchHero";
import { ProgressiveLab } from "./search/v2/ProgressiveLab";
import { OwnCredentialModal } from "./search/v2/OwnCredentialModal";
import { AdapterStatusList } from "./search/AdapterStatusList";
import { ResultsGrid } from "./search/ResultsGrid";
import { PreviewDialog } from "./search/PreviewDialog";
import { BottomProgressRail } from "./search/BottomProgressRail";
import { F86DiagnosticBanner, F90ViewingModeBadge } from "@/components/search/F86DiagnosticBanner";
import { F87SelfTestPanel } from "@/components/search/F87SelfTestPanel";
import { F90LaunchChoiceModal } from "@/components/search/F90LaunchChoiceModal";
import { resolveViewingMode } from "@/lib/launchUrl";
import { DEV_FIXTURE_ROWS, DEV_FIXTURE_TICK_MS, isDevMode, shouldStreamDevFixture } from "./search/devFixture";

const POLL_MS = 2000;

// [F90 §C.4] The one-time "you are watching through Tailscale" hint.
//
// WHY: every "Open in RDP" button is a promise about WHICH browser opens the
// link. Viewed over Tailscale that promise can only be kept by the server's
// ladder, and when the ladder cannot reach a desktop the operator sees a modal
// instead. Neither is obvious the first time, so the hint is shown once and the
// dismissal is remembered - it is not a nag and it is not a blocker.
const F90_HINT_SEEN_KEY = "f90.hintSeen";

function F90TailscaleHint() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"tailscale-local" | null>(null);

  useEffect(() => {
    let seen = false;
    try {
      seen = window.localStorage.getItem(F90_HINT_SEEN_KEY) === "1";
    } catch {
      seen = false;
    }
    const { mode } = resolveViewingMode();
    setMode(seen ? null : mode === "tailscale-local" ? mode : null);
  }, []);

  if (mode !== "tailscale-local") return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(F90_HINT_SEEN_KEY, "1");
    } catch {
      /* a denied storage area simply means the hint returns next visit */
    }
    setMode(null);
  };

  return (
    <div
      id="f90.tailscaleHint"
      data-testid="f90-tailscale-hint"
      role="status"
      className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 flex items-start gap-3 text-xs"
    >
      <span aria-hidden className="text-sm leading-none">💡</span>
      <p className="flex-1 text-secondary">
        {t("viewingMode.hint.body")}{" "}
        <a
          href="https://github.com/dekarita/supreme-lamp/blob/main/PROJECT-CONTEXT-v2-CANONICAL.md"
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-primary"
        >
          {t("viewingMode.hint.learnMore")}
        </a>
      </p>
      <button
        id="f90.tailscaleHint.dismiss"
        data-testid="f90-tailscale-hint-dismiss"
        type="button"
        onClick={dismiss}
        className="h-7 px-2 rounded border border-default text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {t("viewingMode.hint.dismiss")}
      </button>
    </div>
  );
}

export default function Search() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const phase = useSearchStore((s) => s.phase);
  const lastErrorCode = useSearchStore((s) => s.lastErrorCode);
  const queryGeneration = useSearchStore((s) => s.queryGeneration);
  const hasQuery = useSearchStore((s) => s.normalizedQuery.length > 0 || s.lastSubmittedQuery.length > 0);
  const totalResults = useSearchStore((s) => s.resultOrder.length);
  const visibleResults = useSearchStore(selectVisibleResults);
  const visibleCount = visibleResults.length;
  const categoryCount = new Set(visibleResults.map((r) => r.category)).size;
  const showProgress = useSearchStore((s) => s.showProgress);
  const fetchCount = useSearchStore((s) => Object.keys(s.fetches).length);
  const filterCount = useSearchStore(selectFilterSelectionCount);
  const adapters = useSearchStore((s) => s.adapters);
  const cancelling = useSearchStore((s) => s.cancelling);
  const cancelSearch = useSearchStore((s) => s.cancelSearch);
  const submit = useSearchStore((s) => s.submit);
  const view = useSearchUiStore((s) => s.view);
  const endAnimation = useSearchUiStore((s) => s.endAnimation);
  const backToLanding = useSearchUiStore((s) => s.backToLanding);
  const devFixtureGen = useSearchUiStore((s) => s.devFixtureGen);
  const lastSubmittedQuery = useSearchStore((s) => s.lastSubmittedQuery);
  const queryRef = useRef<string | null>(null);
  // [F78 §2.2] "+ Add site" modal state (owned by the page, not the bar).
  const [addSiteOpen, setAddSiteOpen] = useState(false);

  // [F56-c v3] §3 DEV fixture fallback: when a settled search produced zero
  // live results, stream fixture rows into the SAME normalized ingest path so
  // progressive states are visible before F56-d's transport exists. Live
  // partials always win: if anything else appends rows, the stream stops.
  useEffect(() => {
    const st = useSearchStore.getState();
    const ui = useSearchUiStore.getState();
    if (
      !st.showProgress ||
      !shouldStreamDevFixture({
        phase,
        totalResults: st.resultOrder.length,
        queryGeneration: st.queryGeneration,
        devFixtureGen: ui.devFixtureGen,
      })
    )
      return;
    // Latch first (outside the deps) so the interval survives the re-render.
    ui.setDevFixtureGen(st.queryGeneration);
    let i = 0;
    const id = window.setInterval(() => {
      const cur = useSearchStore.getState();
      if (cur.resultOrder.length !== i) {
        window.clearInterval(id); // live results (or a new search) arrived
        return;
      }
      const row = DEV_FIXTURE_ROWS[i];
      if (!row) {
        window.clearInterval(id);
        return;
      }
      i += 1;
      cur.ingestResults([row]);
    }, DEV_FIXTURE_TICK_MS);
    return () => window.clearInterval(id);
    // devFixtureGen is deliberately NOT a dep: the latch must never kill the stream.
  }, [phase, queryGeneration, showProgress]);

  // Palette prefill (?q=...): apply once per value, never auto-submit (Plan §D).
  const q = params.get("q");
  useEffect(() => {
    if (q != null && queryRef.current !== q) {
      queryRef.current = q;
      useSearchStore.getState().applyPrefill(q);
      document.getElementById("f56.search.query")?.focus();
    }
  }, [q]);

  // Incremental status polling while the search is live (Plan §F).
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useSearchStore.getState();
      if (s.phase === "queued" || s.phase === "running" || s.phase === "partial") void s.pollOnce();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  const busy = phase === "queued" || phase === "running" || phase === "partial";
  const rateLimited = Object.values(adapters).some((a) => a.status === "rate-limited");
  const landing = view === "landing";

  return (
    <>
    {/* [F90 §C.3] persistent viewing-mode badge: always visible, never diag-gated. */}
    <F90ViewingModeBadge />
    {/* [F90 §C.2] the explicit "where should this link open?" modal. */}
    <F90LaunchChoiceModal />
    <div id="f56.search.view" data-testid="search-page" data-view={view} className="mx-auto w-full max-w-[760px] flex flex-col gap-6">
      {/* [F85 §3] ?diag=1-only diagnostic banner: "which F84 features are live
          in THIS bundle + THIS server". Renders nothing otherwise, so the
          normal surface (and every existing screenshot) is untouched. */}
      <F86DiagnosticBanner />
      {/* [F87 §C.2] ?selftest=1-only eleven-site production proof. */}
      <F87SelfTestPanel />
      {/* [F90 §C.4] one-time "view through WEB DESKTOP" hint (tailscale only). */}
      <F90TailscaleHint />
      {/* §2: landing surface = title, the all-in-one bar, one sub-line and
          three quiet chips. NOTHING else (no chips, no sliders, no caps). */}
      <div id="f56.search.v2.landing" hidden={!landing} className={landing ? "flex flex-col items-center" : "hidden"}>
        <h1 className="text-2xl font-semibold text-primary">{t("search.page.title")}</h1>
      </div>

      <CommandBar onAnimationEnd={endAnimation} />

      {/* [F78 §2.2] "+ Add site" quick-add entry point, next to the search bar.
          Opens the two-field modal; the saved source lands in "Your sites". */}
      <div className="flex items-center justify-end">
        <button
          id="f78.search.addSite"
          data-testid="add-site-button"
          type="button"
          onClick={() => setAddSiteOpen(true)}
          className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Plus className="size-3.5" aria-hidden />
          {t("search.addSite")}
        </button>
      </div>

      <AddSiteQuick open={addSiteOpen} onClose={() => setAddSiteOpen(false)} />

      {/* [F83 §2.1] Stored sites stay visible on the LANDING view too. Before
          this, <CustomSitesRow/> rendered only inside the results section, so
          an operator who had added a site saw nothing - not even the F81
          delete controls - until a query was submitted. The row hides itself
          when no site is stored (no placeholder), so the landing surface stays
          bar-only for everyone else. Empty query keeps the "Open <site> in
          Lab" CTA: no query is invented for a stored site. */}
      {landing && <CustomSitesRow query="" />}

      {landing ? (
        <SearchHero />
      ) : (
        <section id="f56.search.v2.results" className="flex flex-col gap-6">
          {/* [F79 D5] Stored sites remain first, even on a zero-result search. */}
          <CustomSitesRow query={lastSubmittedQuery} />
          {showProgress ? (
            <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-primary">{t("search.results.label")}</h2>
                  <span id="f56.search.ownStorageResults" data-testid="own-storage-results" className="text-xs text-tertiary">
                    {t("search.scope.ownStorage")}: {String(totalResults)}
                  </span>
                  <button
                    type="button"
                    data-testid="back-to-landing"
                    onClick={() => backToLanding()}
                    className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {t("search.v2.backToLanding")}
                  </button>
                  <button
                    id="f56.search.cancelSearch"
                    type="button"
                    data-testid="cancel-search"
                    disabled={!busy || cancelling}
                    onClick={() => void cancelSearch()}
                    className="ml-auto h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {t("search.actions.cancelSearch")}
                  </button>
                </div>

                <div
                  id="f56.search.statusLive"
                  role="status"
                  aria-live="polite"
                  aria-label={t("search.a11y.liveStatus")}
                  data-testid="status-live"
                  className="text-xs font-mono text-secondary"
                >
                  {t("search.filters.label")}: {String(filterCount)} — {phase} — gen {String(queryGeneration)}
                  {visibleCount !== totalResults ? " — " + t("search.results.noFilterMatch") : ""}
                </div>

                <ProgressiveLab />
                <AdapterStatusList />
            </>
          ) : null}

          <section className="flex flex-col gap-6">
            {showProgress || categoryCount >= 2 ? (
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="f56.search.resultsHeader" className="text-sm font-semibold text-primary">
                {t("search.results.label")}
              </h2>
              {isDevMode() && totalResults > 0 && devFixtureGen > 0 && devFixtureGen === queryGeneration ? (
                <span id="f56.search.devFixtureNote" data-testid="dev-fixture-note" className="text-xs text-tertiary">
                  {t("search.v3.devFixture.note")}
                </span>
              ) : null}
            </div>
            ) : null}
            {phase === "failed" ? (
              <div id="f56.search.resultsError" role="alert" data-testid="results-error" className="text-sm text-danger bg-danger/10 rounded p-3 flex items-center gap-3">
                <span>
                  {lastErrorCode === "RATE_LIMITED"
                    ? t("search.errors.rateLimited")
                    : lastErrorCode === "CLASSIFIER_BLOCKED"
                      ? t("search.errors.classifierBlocked")
                      : lastErrorCode === "SNAPSHOT_MISMATCH"
                        ? t("search.errors.snapshotMismatch")
                        : lastErrorCode === "CONTENT_LENGTH_REQUIRED" || lastErrorCode === "WIRE_LENGTH_MISMATCH"
                          ? t("search.errors.contentLengthRequired")
                          : t("search.errors.generic")}
                </span>
                <button
                  type="button"
                  data-testid="error-retry"
                  onClick={() => void submit()}
                  className="h-11 px-3 rounded-md border border-default text-xs hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {t("search.actions.retry")}
                </button>
              </div>
            ) : null}
            {phase === "failed" && lastErrorCode === "CLASSIFIER_BLOCKED" ? (
              <p id="f56.search.classifierBlock" className="text-xs text-warning">
                {t("search.errors.classifierBlocked")}
              </p>
            ) : null}
            {phase === "failed" && (lastErrorCode === "CONTENT_LENGTH_REQUIRED" || lastErrorCode === "WIRE_LENGTH_MISMATCH") ? (
              <p id="f56.search.contentLengthFailure" className="text-xs text-warning">
                {t("search.errors.contentLengthRequired")}
              </p>
            ) : null}
            {phase === "failed" && lastErrorCode === "SNAPSHOT_MISMATCH" ? (
              <p id="f56.search.snapshotFailure" className="text-xs text-warning">
                {t("search.errors.snapshotMismatch")}
              </p>
            ) : null}
            {busy && totalResults === 0 ? <LoadingState /> : null}
            {(phase === "complete" || phase === "empty") && totalResults === 0 ? (
              <EmptyState query={lastSubmittedQuery} onAddSite={() => setAddSiteOpen(true)} />
            ) : null}
            {!hasQuery && phase === "idle" ? (
              <p id="f56.search.resultsEmpty" data-testid="results-noquery" className="text-sm text-secondary">
                {t("search.results.noQuery")}
              </p>
            ) : null}
            {showProgress && rateLimited ? (
              <p id="f56.search.resultsRateLimited" data-testid="results-rate-limited" className="text-sm text-warning">
                {t("search.errors.rateLimited")}
              </p>
            ) : null}
            {totalResults > 0 && visibleCount === 0 ? (
              <p data-testid="results-no-filter-match" className="text-sm text-secondary">
                {t("search.results.noFilterMatch")}
              </p>
            ) : null}
            {totalResults > 0 ? <ResultsGrid /> : null}
          </section>
        </section>
      )}

      {!landing ? (
        <>
          {showProgress || fetchCount > 0 ? <BottomProgressRail /> : null}
          <PreviewDialog />
        </>
      ) : null}
      <OwnCredentialModal />
    </div>
    </>
  );
}
