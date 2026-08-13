import type { GitHubClient } from "./github-types.js"
import { getPullRequestStack } from "./github-stack.js"
import { getPullRequestStatuses } from "./github-status.js"
import { execFileRunner, type ProcessRunner } from "./github-transport.js"

export type {
  AvailablePullRequestStatus,
  GitHubAuthenticationRequired,
  GitHubBatch,
  GitHubBatchLimitExceeded,
  GitHubCancelled,
  GitHubCliMissing,
  GitHubClient,
  GitHubFailure,
  GitHubUnavailable,
  InvalidGitHubResponse,
  PullRequestBlocker,
  PullRequestCi,
  PullRequestDiagnostic,
  PullRequestItemFailure,
  PullRequestMergeability,
  PullRequestNotFound,
  PullRequestState,
  PullRequestStatus,
} from "./github-types.js"
export { statusAppearance } from "./github-appearance.js"
export type { StatusAppearance } from "./github-appearance.js"
export { execFileRunner } from "./github-transport.js"
export type { ProcessRunner } from "./github-transport.js"

export function createGitHubClient(runner: ProcessRunner = execFileRunner): GitHubClient {
  return {
    get: (pullRequests, options) => getPullRequestStatuses(runner, pullRequests, options),
    getStack: (pullRequest, options) => getPullRequestStack(runner, pullRequest, options),
  }
}
