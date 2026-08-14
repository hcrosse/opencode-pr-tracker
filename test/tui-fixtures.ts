import type { AvailablePullRequestStatus, GitHubClient, PullRequestState } from "../src/github.js"
import type { PullRequestAttachment, StateStore } from "../src/state.js"
import { parsePullRequestUrl, type PullRequestUrl } from "../src/url.js"

const parsed = parsePullRequestUrl("https://github.com/owner/repository/pull/42")
if (!parsed.ok) throw new Error("test fixture URL is invalid")
export const pullRequest = parsed.value

const secondParsed = parsePullRequestUrl("https://github.com/another/project/pull/7")
if (!secondParsed.ok) throw new Error("second test fixture URL is invalid")
export const secondPullRequest = secondParsed.value

export const attachment: PullRequestAttachment = {
  pullRequest,
  attachedAt: "2026-08-10T12:00:00.000Z",
}

export const secondAttachment: PullRequestAttachment = {
  pullRequest: secondPullRequest,
  attachedAt: "2026-08-10T12:01:00.000Z",
}

export function stateStore(items: readonly PullRequestAttachment[] = [attachment]): StateStore {
  return {
    async list() {
      return { ok: true, value: items }
    },
    async attach(_sessionID, _pullRequest, options) {
      const validation = await options?.validate?.()
      if (validation !== undefined && !validation.ok) return validation
      return { ok: true, value: "added" }
    },
    async attachGroup(sessionID, resolve) {
      const resolution = await resolve()
      if (!resolution.ok) return resolution
      let added = false
      for (const member of resolution.value) {
        const outcome = await this.attach(sessionID, member)
        if (!outcome.ok) return outcome
        if (outcome.value === "added") added = true
      }
      return { ok: true, value: added ? "added" : "already_attached" }
    },
    async detach() {
      return { ok: true, value: "removed" }
    },
    async detachByNumber() {
      return { ok: true, value: { tag: "absent" } }
    },
    async removeSession() {
      return { ok: true, value: "absent" }
    },
  }
}

export function available(
  state: PullRequestState = {
    tag: "Open",
    ci: "passed",
    isDraft: false,
    mergeability: "mergeable",
    blocker: "none",
  },
  value: PullRequestUrl = pullRequest,
): AvailablePullRequestStatus {
  return {
    tag: "Available",
    pullRequest: value,
    title: "Track pull requests",
    state,
    stale: false,
  }
}

export function githubStatuses(
  resolve: (pullRequest: PullRequestUrl) => AvailablePullRequestStatus | Promise<AvailablePullRequestStatus> = (
    value,
  ) => available(undefined, value),
): GitHubClient {
  return {
    async getStack(requested) {
      return { ok: true, value: [requested] }
    },
    async get(pullRequests) {
      return {
        ok: true,
        value: await Promise.all(
          pullRequests.map(async (value) => ({ ok: true, value: await resolve(value) }) as const),
        ),
      }
    },
  }
}
