import type { GitHubClient } from "./github-types.js"
import { getPullRequestStack, getPullRequestStacks } from "./github-stack.js"
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
  GitHubStackBatch,
  GitHubUnavailable,
  InvalidGitHubResponse,
  PullRequestBlocker,
  PullRequestCi,
  PullRequestDiagnostic,
  PullRequestItemFailure,
  PullRequestMergeability,
  PullRequestNotFound,
  PullRequestState,
  PullRequestStackMembership,
  PullRequestStatus,
} from "./github-types.js"
export { statusAppearance } from "./github-appearance.js"
export type { StatusAppearance } from "./github-appearance.js"
export { execFileRunner } from "./github-transport.js"
export type { ProcessRunner } from "./github-transport.js"

export function createGitHubClient(runner: ProcessRunner = execFileRunner): GitHubClient {
  return {
    async get(pullRequests, options = {}) {
      return getPullRequestStatuses(runner, pullRequests, options)
    },
    async getStack(pullRequest, options = {}) {
      return getPullRequestStack(runner, pullRequest, options)
    },
    async getStacks(pullRequests, options = {}) {
      return getPullRequestStacks(runner, pullRequests, options)
    },
  }
}
