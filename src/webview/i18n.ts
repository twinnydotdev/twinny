import { initReactI18next } from "react-i18next"
import i18n from "i18next"

import de from "./assets/locales/de.json"
import en from "./assets/locales/en.json"
import es from "./assets/locales/es.json"
import esCL from "./assets/locales/es-CL.json"
import ja from "./assets/locales/ja.json"
import zhCN from "./assets/locales/zh-CN.json"
import zhHK from "./assets/locales/zh-HK.json"

i18n.use(initReactI18next).init({
  fallbackLng: "en",
  resources: {
    de: { translation: de },
    en: { translation: en },
    es: { translation: es },
    esCL: { translation: esCL },
    ja: { translation: ja },
    "zh-CN": { translation: zhCN },
    "zh-HK": { translation: zhHK }
  },
  detection: {
    order: ["localStorage"],
    availableLanguages: ["en", "zh-CN", "zh-HK", "ja", "es", "esCL", "de"]
  }
})

export default i18n
