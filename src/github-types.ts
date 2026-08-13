import type { NonEmptyPullRequests, PullRequestUrl, Result } from "./url.js"

export type PullRequestCi = "passed" | "pending" | "failed" | "none"
export type PullRequestMergeability = "mergeable" | "conflicting" | "unknown"
export type PullRequestBlocker = "behind" | "none"

export type PullRequestState =
  | Readonly<{
      tag: "Open"
      ci: PullRequestCi
      mergeability: PullRequestMergeability
      blocker: PullRequestBlocker
    }>
  | Readonly<{ tag: "Merged" }>
  | Readonly<{ tag: "Closed" }>

export type AvailablePullRequestStatus = Readonly<{
  tag: "Available"
  pullRequest: PullRequestUrl
  title: string
  state: PullRequestState
}> &
  (Readonly<{ stale: false }> | Readonly<{ stale: true; diagnostic: PullRequestDiagnostic }>)

export type PullRequestStatus =
  | AvailablePullRequestStatus
  | Readonly<{ tag: "Unavailable"; diagnostic?: PullRequestDiagnostic }>

export type GitHubUnavailable = Readonly<{
  tag: "GitHubUnavailable"
  message: "GitHub status unavailable"
  cause: unknown
}>

export type GitHubCliMissing = Readonly<{
  tag: "GitHubCliMissing"
  message: "GitHub CLI is not installed"
  cause: unknown
}>

export type GitHubAuthenticationRequired = Readonly<{
  tag: "GitHubAuthenticationRequired"
  message: "GitHub CLI authentication required"
  cause: unknown
}>

export type GitHubCancelled = Readonly<{
  tag: "GitHubCancelled"
  message: "GitHub status request cancelled"
  cause: unknown
}>

export type PullRequestNotFound = Readonly<{
  tag: "PullRequestNotFound"
  message: "Pull request does not exist or is not accessible"
}>

export type InvalidGitHubResponse = Readonly<{
  tag: "InvalidGitHubResponse"
  message: "GitHub returned an invalid pull request response"
}>

export type GitHubBatchLimitExceeded = Readonly<{
  tag: "GitHubBatchLimitExceeded"
  limit: 20
  message: "GitHub batch cannot contain more than 20 pull requests"
}>

export type GitHubFailure =
  | GitHubCliMissing
  | GitHubAuthenticationRequired
  | GitHubUnavailable
  | GitHubCancelled
  | PullRequestNotFound
  | InvalidGitHubResponse
  | GitHubBatchLimitExceeded

export type PullRequestItemFailure = Exclude<GitHubFailure, GitHubCancelled | GitHubBatchLimitExceeded>

export type GitHubBatch = readonly Result<AvailablePullRequestStatus, PullRequestItemFailure>[]

export type PullRequestDiagnostic = Exclude<GitHubFailure, GitHubCancelled | GitHubBatchLimitExceeded>["tag"]

export type GitHubClient = Readonly<{
  get(
    pullRequests: readonly PullRequestUrl[],
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Result<GitHubBatch, GitHubFailure>>
  getStack(
    pullRequest: PullRequestUrl,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Result<NonEmptyPullRequests, GitHubFailure>>
}>
