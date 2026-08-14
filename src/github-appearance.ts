import { casesHandled } from "./exhaustive.js"
import type { PullRequestCi, PullRequestDiagnostic, PullRequestState, PullRequestStatus } from "./github-types.js"

export type StatusAppearance = Readonly<{
  tone: "green" | "yellow" | "red" | "purple" | "gray"
  label: string
  strikethrough: boolean
  stale: boolean
}>

type BaseStatusAppearance = Omit<StatusAppearance, "stale">

const openAppearances = {
  passed: { tone: "green", label: "passed", strikethrough: false },
  pending: { tone: "yellow", label: "pending", strikethrough: false },
  failed: { tone: "red", label: "failed", strikethrough: false },
  none: { tone: "gray", label: "no checks", strikethrough: false },
} satisfies Record<PullRequestCi, BaseStatusAppearance>

const diagnosticLabels = {
  GitHubCliMissing: "install gh",
  GitHubAuthenticationRequired: "authenticate",
  GitHubUnavailable: "GitHub unavailable",
  PullRequestNotFound: "inaccessible",
  InvalidGitHubResponse: "invalid response",
} satisfies Record<PullRequestDiagnostic, string>

function stateAppearance(state: PullRequestState): BaseStatusAppearance {
  switch (state.tag) {
    case "Open": {
      switch (state.mergeability) {
        case "conflicting":
          return { tone: "red", label: "conflict", strikethrough: false }
        case "mergeable":
        case "unknown":
          switch (state.ci) {
            case "failed":
              return openAppearances[state.ci]
            case "pending":
              return state.isDraft ? { tone: "gray", label: "draft", strikethrough: false } : openAppearances[state.ci]
            case "none":
            case "passed":
              if (state.isDraft) return { tone: "gray", label: "draft", strikethrough: false }
              switch (state.blocker) {
                case "behind":
                  return { tone: "yellow", label: "behind", strikethrough: false }
                case "none":
                  return openAppearances[state.ci]
                default:
                  return casesHandled(state.blocker)
              }
            default:
              return casesHandled(state.ci)
          }
        default:
          return casesHandled(state.mergeability)
      }
    }
    case "Merged":
      return { tone: "purple", label: "merged", strikethrough: true }
    case "Closed":
      return { tone: "red", label: "closed", strikethrough: true }
    default:
      return casesHandled(state)
  }
}

export function statusAppearance(status: PullRequestStatus): StatusAppearance {
  if (status.tag === "Unavailable") {
    return {
      tone: "gray",
      label: status.diagnostic === undefined ? "unavailable" : diagnosticLabels[status.diagnostic],
      strikethrough: false,
      stale: false,
    }
  }

  return { ...stateAppearance(status.state), stale: status.stale }
}
