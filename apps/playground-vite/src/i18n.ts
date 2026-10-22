import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "./locales/en/common.json";
import thCommon from "./locales/th/common.json";
import enAuth from "./features/auth/locales/en.json";
import thAuth from "./features/auth/locales/th.json";

const lng = new URLSearchParams(location.search).get("lng") ?? "en";

void i18n.use(initReactI18next).init({
  lng,
  fallbackLng: "en",
  defaultNS: "common",
  resources: { en: { common: enCommon, auth: enAuth }, th: { common: thCommon, auth: thAuth } },
  interpolation: { escapeValue: false },
});

export default i18n;
