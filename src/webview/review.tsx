import React, { FormEvent, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { REVIEW_EVENT_NAME, WORKSPACE_STORAGE_KEY } from "../common/constants"

import { useGithubPRs } from "./hooks/useGithubPRs"
import { StorageType, useStorageContext } from "./hooks/useStorageContext"
import { emit, useServerQuery } from "./messaging"

import styles from "./styles/review.module.css"

type InputEvent = Event | FormEvent<HTMLElement>

const valueOf = (e: InputEvent) =>
  (e as unknown as React.ChangeEvent<HTMLInputElement>).target.value

export const Review = () => {
  const { t } = useTranslation()
  const { prs, getPrs, startReview, isLoading } = useGithubPRs()
  const { data: local, isLoading: localLoading } = useServerQuery(
    REVIEW_EVENT_NAME.getLocalStatus
  )
  const [base, setBase] = useState("")
  const [starting, setStarting] = useState(false)

  const {
    context: owner,
    setContext: setOwner,
    loaded: ownerLoaded
  } = useStorageContext<string>(
    StorageType.Workspace,
    WORKSPACE_STORAGE_KEY.reviewOwner
  )
  const {
    context: repo,
    setContext: setRepo,
    loaded: repoLoaded
  } = useStorageContext<string>(
    StorageType.Workspace,
    WORKSPACE_STORAGE_KEY.reviewRepo
  )

  useEffect(() => {
    if (local?.base && !base) setBase(local.base)
  }, [local?.base])

  // Storage values arrive as undefined before the first read, so wait for
  // both the git status and the stored fields before deciding to prefill.
  const detected = local?.github
  const storedLoaded = ownerLoaded && repoLoaded
  useEffect(() => {
    if (!detected || !storedLoaded) return
    if (!owner && !repo) {
      setOwner(detected.owner)
      setRepo(detected.repo)
    }
  }, [detected?.owner, detected?.repo, storedLoaded])

  useEffect(() => {
    if (!prs.length && owner && repo) getPrs(owner, repo)
  }, [owner, repo])

  const differsFromDetected =
    !!detected &&
    (owner?.toLowerCase() !== detected.owner.toLowerCase() ||
      repo?.toLowerCase() !== detected.repo.toLowerCase())

  const useDetected = () => {
    if (!detected) return
    setOwner(detected.owner)
    setRepo(detected.repo)
    getPrs(detected.owner, detected.repo)
  }

  const isCurrentBranch = (ref?: string) =>
    !!ref && !!local?.branch && ref === local.branch

  // The pull request for the branch that is checked out goes first.
  const sortedPrs = [...prs].sort(
    (a, b) =>
      Number(isCurrentBranch(b.head?.ref)) - Number(isCurrentBranch(a.head?.ref))
  )

  const reviewWorkingTree = () => {
    setStarting(true)
    emit(REVIEW_EVENT_NAME.reviewLocal, { mode: "working-tree" })
  }

  const reviewBranch = () => {
    setStarting(true)
    emit(REVIEW_EVENT_NAME.reviewLocal, { mode: "branch", base })
  }

  const busy = starting || isLoading

  return (
    <div className={styles.reviewContainer}>
      <div className="tw-page-header">
        <h3>{t("review-local-title")}</h3>
      </div>
      {localLoading ? null : !local?.isRepository ? (
        <p>{t("review-no-repository")}</p>
      ) : (
        <>
          <p>{t("review-on-branch", { branch: local.branch })}</p>
          <div className={styles.localActions}>
            <div className={styles.localAction}>
              <VSCodeButton
                onClick={reviewWorkingTree}
                disabled={busy || local.workingTreeFiles === 0}
              >
                <span className="codicon codicon-diff" />
                {t("review-working-tree")}
              </VSCodeButton>
              <span className={styles.actionDetail}>
                {local.workingTreeFiles
                  ? t("review-working-tree-detail", {
                      count: local.workingTreeFiles
                    })
                  : t("review-no-changes")}
              </span>
            </div>
            <div className={styles.localAction}>
              <div className={styles.branchRow}>
                <VSCodeButton onClick={reviewBranch} disabled={busy || !base}>
                  <span className="codicon codicon-git-branch" />
                  {t("review-branch")}
                </VSCodeButton>
                <VSCodeTextField
                  value={base}
                  onInput={(e) => setBase(valueOf(e))}
                  placeholder={t("review-base-placeholder")}
                />
              </div>
              <span className={styles.actionDetail}>
                {base && base === local.base && local.branchFiles
                  ? t("review-branch-detail", {
                      count: local.branchFiles,
                      base
                    })
                  : base
                    ? ""
                    : t("review-no-changes")}
              </span>
            </div>
          </div>
        </>
      )}
      <p className={styles.hint}>{t("review-how-it-works")}</p>

      <h4>{t("review-github-title")}</h4>
      <p>{t("review-github-intro")}</p>
      {detected && (
        <div className={styles.detected}>
          <span className="codicon codicon-github" />
          {differsFromDetected ? (
            <button className={styles.linkButton} onClick={useDetected}>
              {t("review-github-use-detected", detected)}
            </button>
          ) : (
            <span>
              {t("review-github-detected")}: {detected.owner}/{detected.repo}
            </span>
          )}
        </div>
      )}
      <div className={styles.prInputContainer}>
        <VSCodeTextField
          value={owner || ""}
          onChange={(e) => setOwner(valueOf(e))}
          placeholder={t("review-owner-placeholder")}
        />
        <VSCodeTextField
          value={repo || ""}
          onChange={(e) => setRepo(valueOf(e))}
          placeholder={t("review-repository-placeholder")}
        />
        <div className={styles.prButtonContainer}>
          <VSCodeButton
            onClick={() => getPrs(owner, repo)}
            disabled={isLoading || !owner || !repo}
          >
            {isLoading
              ? t("review-fetching-button")
              : t("review-fetch-prs-button")}
          </VSCodeButton>
        </div>
      </div>

      {prs.length > 0 && (
        <div className={styles.prListContainer}>
          <h4>{t("pull-requests")}</h4>
          <ul className={styles.prList}>
            {sortedPrs.map((pr) => (
              <li key={pr.number} className={styles.prItem}>
                <span className={styles.prTitle}>
                  <a href={pr.html_url}>
                    {pr.title} (#{pr.number})
                  </a>
                  {isCurrentBranch(pr.head?.ref) && (
                    <span className={styles.prBadge}>
                      {t("review-current-branch")}
                    </span>
                  )}
                  <span className={styles.prMeta}>
                    {pr.draft ? `${t("review-draft")} · ` : ""}
                    {pr.user?.login || ""}
                  </span>
                </span>
                <VSCodeButton
                  onClick={() => {
                    if (!owner || !repo) return
                    setStarting(true)
                    startReview(owner, repo, pr.number, pr.title)
                  }}
                  title={t("review-pr-title", { prNumber: pr.number })}
                  appearance="icon"
                  disabled={busy}
                >
                  <span className="codicon codicon-git-pull-request"></span>
                </VSCodeButton>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
