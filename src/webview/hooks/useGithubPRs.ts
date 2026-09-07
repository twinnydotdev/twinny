import { useState } from "react"

import { GITHUB_EVENT_NAME } from "../../common/constants"
import { GitHubPr } from "../../common/types"
import { bridge, emit } from "../messaging"

export const useGithubPRs = () => {
  const [prs, setPRs] = useState<GitHubPr[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const getPrs = async (owner: string | undefined, repo: string | undefined) => {
    if (!owner || !repo) return
    setIsLoading(true)
    try {
      const pullRequests = await bridge.request(
        GITHUB_EVENT_NAME.getPullRequests,
        { owner, repo }
      )
      setPRs(Array.isArray(pullRequests) ? pullRequests : [])
    } catch {
      setPRs([])
    } finally {
      setIsLoading(false)
    }
  }

  const startReview = (
    owner: string | undefined,
    repo: string | undefined,
    selectedPR: number,
    title: string
  ) => {
    if (selectedPR === null) return
    emit(GITHUB_EVENT_NAME.getPullRequestReview, {
      owner,
      repo,
      number: selectedPR,
      title
    })
  }

  return { prs, isLoading, getPrs, startReview }
}
