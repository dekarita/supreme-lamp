import React from "react";
// [F41 plan §2] Entry - fonts + tokens + globals, i18n, React root.
import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/globals.css";
import "./i18n";
import App from "./App";
import { useLangStore } from "@/stores/prefsStore";
import { installLaunchUrlHandle } from "@/lib/launchUrl";
import { installGlobalClickCapture } from "@/lib/globalClickCapture";
import { logButtonAction, updateRecordedAction } from "@/lib/collectorAgent";
import { installFeatureBoundaryReporter } from "@/lib/featureBoundary";

// [F85 §3] Install the feature-detection handle for the diag banner BEFORE the
// root renders (see the comment in src/lib/launchUrl.ts: the banner proves the
// no-fallback contract from the running bundle, not from a server flag).
installLaunchUrlHandle();

// [F104 §3.3] Global click telemetry: ONE document-level listener that
// auto-captures every real Mission Control button click into the collector
// store (the Collector page renders them under "Global clicks"). Killable
// per-build with VITE_F104_GLOBAL_CAPTURE=false; the collector's own UI is
// invisible to the capture (see GLOBAL_CLICK_IGNORE) so the store can never
// feed itself.
if (import.meta.env.VITE_F104_GLOBAL_CAPTURE !== "false") {
  try {
    installGlobalClickCapture({
      record: (rec) => logButtonAction(rec),
      update: (id, patch) => updateRecordedAction(id, patch),
    });
  } catch {
    /* telemetry must never break the app */
  }
}

// [F105 §4.4] FeatureBoundary failures are published as window events
// (src/lib/featureBoundary.ts). This is the F100/F101/F104 consumer: one
// Collector row per distinct failure, so a crashed section is visible in the
// same feed as a failed click - and in the clipboard .mcrec a DVR session
// produces. Idempotent; no network, no storage, no endpoint.
try {
  installFeatureBoundaryReporter();
} catch {
  /* diagnostics must never break the app */
}

// Sync the persisted language into i18next + <html lang>.
const initialLang = useLangStore.getState().lang;
void (async () => {
  const i18n = (await import("./i18n")).default;
  await i18n.changeLanguage(initialLang);
})();

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
