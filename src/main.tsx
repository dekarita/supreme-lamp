import React from "react";
// [F41 plan §2] Entry - fonts + tokens + globals, i18n, React root.
import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/globals.css";
import "./i18n";
import App from "./App";
import { useLangStore } from "@/stores/prefsStore";

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
