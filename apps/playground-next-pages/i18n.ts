import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "./locales/en/common.json";
import thCommon from "./locales/th/common.json";

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: "common",
  initAsync: false,
  resources: { en: { common: enCommon }, th: { common: thCommon } },
  interpolation: { escapeValue: false },
});

export default i18n;
