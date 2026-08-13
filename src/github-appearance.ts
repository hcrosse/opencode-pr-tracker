import { casesHandled } from "./exhaustive.js"
import type { PullRequestCi, PullRequestDiagnostic, PullRequestState, PullRequestStatus } from "./github-types.js"

export type StatusAppearance = Readonly<{
  tone: "green" | "yellow" | "red" | "purple" | "gray"
  label: string
  strikethrough: boolean
}>

const openAppearances = {
  passed: { tone: "green", label: "checks passed", strikethrough: false },
  pending: { tone: "yellow", label: "checks pending", strikethrough: false },
  failed: { tone: "red", label: "checks failed", strikethrough: false },
  none: { tone: "gray", label: "no checks", strikethrough: false },
} satisfies Record<PullRequestCi, StatusAppearance>

const diagnosticLabels = {
  GitHubCliMissing: "install gh",
  GitHubAuthenticationRequired: "run gh auth login",
  GitHubUnavailable: "GitHub unavailable",
  PullRequestNotFound: "not found or inaccessible",
  InvalidGitHubResponse: "invalid GitHub response",
} satisfies Record<PullRequestDiagnostic, string>

function stateAppearance(state: PullRequestState): StatusAppearance {
  switch (state.tag) {
    case "Open": {
      switch (state.mergeability) {
        case "conflicting":
          return { tone: "red", label: "merge conflict", strikethrough: false }
        case "mergeable":
        case "unknown":
          switch (state.ci) {
            case "failed":
            case "pending":
              return openAppearances[state.ci]
            case "none":
            case "passed":
              switch (state.blocker) {
                case "behind":
                  return { tone: "yellow", label: "branch behind", strikethrough: false }
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
      label: status.diagnostic === undefined ? "status unavailable" : diagnosticLabels[status.diagnostic],
      strikethrough: false,
    }
  }

  const appearance = stateAppearance(status.state)
  return status.stale
    ? { ...appearance, label: `${appearance.label} (stale; ${diagnosticLabels[status.diagnostic]})` }
    : appearance
}
