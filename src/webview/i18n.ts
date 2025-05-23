import { initReactI18next } from "react-i18next"
import i18n from "i18next"

import de from "./assets/locales/de.json"
import en from "./assets/locales/en.json"
import es from "./assets/locales/es.json"
import esCL from "./assets/locales/es-CL.json"
import fr from "./assets/locales/fr.json"
import it from "./assets/locales/it.json"
import ja from "./assets/locales/ja.json"
import ko from "./assets/locales/ko.json"
import nl from "./assets/locales/nl.json"
import pt from "./assets/locales/pt.json"
import ru from "./assets/locales/ru.json"
import zhCN from "./assets/locales/zh-CN.json"
import zhHK from "./assets/locales/zh-HK.json"

i18n.use(initReactI18next).init({
  fallbackLng: "en",
  resources: {
    de: { translation: de },
    en: { translation: en },
    es: { translation: es },
    esCL: { translation: esCL },
    fr: { translation: fr },
    it: { translation: it },
    ja: { translation: ja },
    ko: { translation: ko },
    nl: { translation: nl },
    pt: { translation: pt },
    ru: { translation: ru },
    "zh-CN": { translation: zhCN },
    "zh-HK": { translation: zhHK }
  },
  detection: {
    order: ["localStorage"],
    availableLanguages: ["en", "zh-CN", "zh-HK", "ja", "es", "esCL", "de", "fr", "it", "pt", "ru", "ko", "nl"]
  }
})

export default i18n
