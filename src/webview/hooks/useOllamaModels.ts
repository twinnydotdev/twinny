import { EVENT_NAME } from "../../common/constants"
import { useServerState } from "../messaging"

export const useOllamaModels = () => {
  const { data } = useServerState(EVENT_NAME.twinnyFetchOllamaModels, [])
  return { models: data }
}
