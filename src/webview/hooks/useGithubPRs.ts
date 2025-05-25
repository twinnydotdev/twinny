import { useEffect, useState } from "react"

import { GITHUB_EVENT_NAME } from "../../common/constants"
import { GitHubPr } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useGithubPRs = () => {
  const [prs, setPRs] = useState<Array<GitHubPr>>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data
      if (message.type === GITHUB_EVENT_NAME.getPullRequests) {
        setPRs(message.data)
        setIsLoading(false)
      }
    }

    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  const getPrs = (owner: string | undefined, repo: string | undefined) => {
    setIsLoading(true)
    global.vscode.postMessage({
      type: GITHUB_EVENT_NAME.getPullRequests,
      data: { owner, repo }
    })
  }

  const startReview = (
    owner: string | undefined,
    repo: string | undefined,
    selectedPR: number,
    title: string
  ) => {
    if (selectedPR === null) return

    global.vscode.postMessage({
      type: GITHUB_EVENT_NAME.getPullRequestReview,
      data: { owner, repo, number: selectedPR, title }
    })
  }

  return {
    prs,
    isLoading,
    getPrs,
    startReview
  }
}
