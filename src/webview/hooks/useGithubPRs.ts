import { useState } from "react"

import { GITHUB_EVENT_NAME } from "../../common/constants"
import { GitHubPr } from "../../common/types"
import { emit, useServerEvent } from "../messaging"

export const useGithubPRs = () => {
  const [prs, setPRs] = useState<GitHubPr[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useServerEvent(GITHUB_EVENT_NAME.getPullRequests, (pullRequests) => {
    setPRs(pullRequests)
    setIsLoading(false)
  })

  const getPrs = (owner: string | undefined, repo: string | undefined) => {
    setIsLoading(true)
    emit(GITHUB_EVENT_NAME.getPullRequests, { owner, repo })
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
