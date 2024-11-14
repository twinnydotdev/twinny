import { initReactI18next } from "react-i18next"
import i18n from "i18next"
import Backend from "i18next-http-backend"

import en from "./assets/locales/en.json"


i18n
  .use(Backend)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    resources: {
      en: { translation: en },
    },
    backend: {
      loadPath: (lng: string) => `"/assets/locales"/${lng}.json`,
    },
    detection: {
      order: ["localStorage"],
      availableLanguages: ["en"],
    },
    debug: true,
    react: {
      useSuspense: true,
      transKeepBasicHtmlNodesFor: ["br", "strong", "i", "p", "u"],
      transWrapTextNodes: "span",
    },
  })

export default i18n
