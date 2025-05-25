import { useEffect } from "react"

export const useEvent = (
  eventName: string,
  handler: ((event: Event) => void) | null,
  target: Window | HTMLElement = window
) => {
  useEffect(() => {
    if (!handler || !target) return

    target.addEventListener(eventName, handler)
    return () => target.removeEventListener(eventName, handler)
  }, [eventName, handler, target])
}
