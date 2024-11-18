import { initReactI18next } from "react-i18next"
import i18n from "i18next"

import en from "./assets/locales/en.json"
import zhCN from "./assets/locales/zh-CN.json"
import zhHK from "./assets/locales/zh-HK.json"

i18n
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    resources: {
      en: { translation: en },
      "zh-CN": { translation: zhCN },
      "zh-HK": { translation: zhHK }
    },
    detection: {
      order: ["localStorage"],
      availableLanguages: [
        "en",
        "zh-CN",
        "zh-HK",
      ]
    },
    debug: true,
  })

export default i18n
