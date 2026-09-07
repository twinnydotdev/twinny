import { EVENT_NAME } from "../../common/constants"
import { LanguageType } from "../../common/types"
import { useServerState } from "../messaging"

export const useLanguage = (): LanguageType | undefined =>
  useServerState(EVENT_NAME.twinnySendLanguage).data
