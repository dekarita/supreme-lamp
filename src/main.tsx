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

// [F85 §3] Install the feature-detection handle for the diag banner BEFORE the
// root renders (see the comment in src/lib/launchUrl.ts: the banner proves the
// no-fallback contract from the running bundle, not from a server flag).
installLaunchUrlHandle();

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
