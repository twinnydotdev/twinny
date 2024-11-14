import React, { FormEvent, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { WORKSPACE_STORAGE_KEY } from "../common/constants"

import { useGithubPRs, useGlobalContext } from "./hooks"

import styles from "./styles/index.module.css"

export const Review = () => {
  const { t } = useTranslation()
  const { prs, getPrs, startReview, isLoading } = useGithubPRs()
  const { context: owner, setContext: setOwner } = useGlobalContext<string>(
    WORKSPACE_STORAGE_KEY.reviewOwner
  )

  const { context: repo, setContext: setRepo } = useGlobalContext<string>(
    WORKSPACE_STORAGE_KEY.reviewRepo
  )

  const handleFetchPRs = () => getPrs(owner, repo)

  const handleStartReview = (selectedPR: number, title: string) => {
    if (!owner || !repo) return
    startReview(owner, repo, selectedPR, title)
  }

  const handleRepoChange = (e: Event | FormEvent<HTMLElement>) => {
    const event = e as unknown as React.ChangeEvent<HTMLInputElement>
    const { value } = event.target
    setRepo(value)
  }

  const handleOwnerChange = (e: Event | FormEvent<HTMLElement>) => {
    const event = e as unknown as React.ChangeEvent<HTMLInputElement>
    const { value } = event.target
    setOwner(value)
  }

  useEffect(() => {
    if (!prs.length && owner && repo) {
      handleFetchPRs()
    }
  }, [owner, repo])

  return (
    <>
      <h3>
        {t("review-pull-requests")}
      </h3>
      <p>
        {t("owner-repo-name")}
      </p>
      <div className={styles.prInputContainer}>
        <VSCodeTextField
          value={owner ? owner : ""}
          onChange={handleOwnerChange}
          placeholder="Owner"
        />
        <VSCodeTextField
          value={repo ? repo : ""}
          onChange={handleRepoChange}
          placeholder="Repository"
        />
        <div className={styles.prButtonContainer}>
          <VSCodeButton
            onClick={handleFetchPRs}
            disabled={isLoading || !owner || !repo}
          >
            {isLoading ? "Fetching..." : "Fetch PRs"}
          </VSCodeButton>
        </div>
      </div>

      {prs.length > 0 && (
        <div className={styles.prListContainer}>
          <h4>
            {t("pull-requests")}
          </h4>
          <ul className={styles.prList}>
            {prs.map((pr) => (
              <li key={pr.number} className={styles.prItem}>
                <span className={styles.prTitle}>
                  <a href={pr.html_url}>
                    {pr.title} (#{pr.number})
                  </a>
                </span>
                <VSCodeButton
                  onClick={() => handleStartReview(pr.number, pr.title)}
                  title={`Review PR #${pr.number}`}
                  appearance="icon"
                  disabled={isLoading}
                >
                  <span className="codicon codicon-git-pull-request"></span>
                </VSCodeButton>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
