// [F41] i18n init - react-i18next with lazy-loaded JSON bundles (plan §2).
// English strings come from the plan §6 token list; Sinhala is authored per
// standard technical usage and MARKED FOR OPERATOR NATIVE REVIEW before ship.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import si from "./si.json";

export const supportedLangs = ["en", "si"] as const;
export type SupportedLang = (typeof supportedLangs)[number];

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    si: { translation: si },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
