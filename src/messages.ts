/** Messages for people: results and failures of tracker requests, shared by tools and the terminal. */
import { Match, Option } from "effect"

import type { AttachFailure, Attached } from "./application/Tracker.ts"
import type { InvalidPullRequestInput, PullRequestRef } from "./domain/PullRequest.ts"
import type { Diagnostic } from "./domain/Snapshot.ts"
import type { AmbiguousPullRequestNumber, Removal } from "./domain/Tracking.ts"
import type { StoredStateInvalid } from "./ports/TrackingRepository.ts"

export type RequestFailure =
  | AttachFailure
  | AmbiguousPullRequestNumber
  | InvalidPullRequestInput
  | StoredStateInvalid

const diagnosticMessages: Record<Diagnostic, string> = {
  AuthenticationRequired: "GitHub needs you to sign in: run `gh auth login`, or set GH_TOKEN.",
  GitHubCliMissing: "Install the GitHub CLI (`gh`), or set GH_TOKEN.",
  GitHubUnavailable: "GitHub is not responding right now. Try again shortly.",
  InvalidResponse: "GitHub returned a response the tracker could not read.",
  NotFound: "The pull request does not exist, or your GitHub account cannot see it.",
}

const list = (refs: readonly PullRequestRef[]): string => {
  const labels = refs.map((ref) => ref.label)

  return labels.length <= 2
    ? labels.join(" and ")
    : `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1) ?? ""}`
}

export function failureMessage(failure: RequestFailure): string {
  return Match.valueTags(failure, {
    AmbiguousPullRequestNumber: ({ matches, number }) =>
      `#${String(number)} matches ${list(matches)}. Use the pull request URL instead.`,
    AttachmentLimitReached: ({ limit, requested }) =>
      `A session can track at most ${String(limit)} pull requests; this would make ${String(requested)}.`,
    GitHubFailure: ({ diagnostic }) => diagnosticMessages[diagnostic],
    InvalidPullRequestInput: () =>
      "Expected a pull request URL, such as github.com/owner/repository/pull/123, or a pull request number.",
    PullRequestUnavailable: ({ diagnostic, url }) => `${url}: ${diagnosticMessages[diagnostic]}`,
    RepositoryUnavailable: () =>
      "This session's directory is not a GitHub repository that `gh` can see. Use the pull request URL instead.",
    StackIncomplete: ({ url }) =>
      `GitHub returned only part of the Stack of ${url}, so nothing was attached. Try again later.`,
    StoredStateInvalid: () =>
      "The tracker's saved state for this session cannot be read. It has been left unchanged.",
  })
}

export function attachedMessage(attached: Attached): string {
  const label = attached.ref.label

  if (!attached.changed) return `${label} is already attached.`

  return attached.stackSize > 1
    ? `Attached ${label} with the rest of its Stack (${String(attached.stackSize)} pull requests).`
    : `Attached ${label}.`
}

export function detachedMessage(removal: Removal, target: string): string {
  return Option.match(removal.removed, {
    onNone: () => `${target} is not attached.`,
    onSome: (ref: PullRequestRef) => `Detached ${ref.label}.`,
  })
}
