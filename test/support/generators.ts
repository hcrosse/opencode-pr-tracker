import * as gs from "@hegeldev/hegel/generators"
import { Result } from "effect"

import { parsePullRequestUrl, type PullRequestRef } from "../../src/domain/PullRequest.ts"
import type { Diagnostic, PullRequestState, Snapshot } from "../../src/domain/Snapshot.ts"

const segmentAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"

/** A repository or owner name as a user might type it, in any case. */
export const segments = gs
  .text({ alphabet: segmentAlphabet, minSize: 1 })
  .filter((segment) => segment !== "." && segment !== "..")

export const pullRequestNumbers = gs.integers({ maxValue: Number.MAX_SAFE_INTEGER, minValue: 1 })

export interface UrlParts {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

/** The parts of a valid pull request URL, before any spelling variation. */
export const urlParts = gs.record({
  number: pullRequestNumbers,
  owner: segments,
  repository: segments,
})

/** A valid pull request URL for `parts`, with optional scheme, host case, and leading zeros. */
export function spellings(parts: UrlParts): gs.Generator<string> {
  return gs.composite((tc) => {
    const scheme = tc.draw(gs.sampledFrom(["https://", ""]))
    const host = tc.draw(gs.sampledFrom(["github.com", "GITHUB.COM", "GitHub.com"]))
    const zeros = "0".repeat(tc.draw(gs.integers({ maxValue: 4, minValue: 0 })))

    return `${scheme}${host}/${parts.owner}/${parts.repository}/pull/${zeros}${String(parts.number)}`
  })
}

/** A canonical reference, constructed through the production parser. */
export const pullRequestRefs: gs.Generator<PullRequestRef> = urlParts.map((parts: UrlParts) =>
  Result.getOrThrow(
    parsePullRequestUrl(
      `https://github.com/${parts.owner}/${parts.repository}/pull/${String(parts.number)}`,
    ),
  ),
)

const ci = gs.sampledFrom(["passed", "pending", "failed", "none"] as const)

const mergeability = gs.sampledFrom(["mergeable", "conflicting", "unknown"] as const)

export const pullRequestStates: gs.Generator<PullRequestState> = gs.oneOf<PullRequestState>(
  gs.record({
    _tag: gs.just("Open" as const),
    behind: gs.booleans(),
    ci,
    draft: gs.booleans(),
    mergeability,
  }),
  gs.just({ _tag: "Merged" }),
  gs.just({ _tag: "Closed" }),
)

export const snapshots: gs.Generator<Snapshot> = gs.record({
  ref: pullRequestRefs,
  state: pullRequestStates,
  title: gs.text(),
})

export const diagnostics = gs.sampledFrom<Diagnostic>([
  "GitHubCliMissing",
  "AuthenticationRequired",
  "GitHubUnavailable",
  "NotFound",
  "InvalidResponse",
])
