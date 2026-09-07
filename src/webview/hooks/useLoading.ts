import { useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { useServerEvent } from "../messaging"

/** The extension's current "what am I busy with" label, if any. */
export const useLoading = () => {
  const [loader, setLoader] = useState<string | undefined>()
  useServerEvent(EVENT_NAME.twinnySendLoader, setLoader)
  return loader
}
