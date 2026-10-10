import { PullRequestState, Status, type Diagnostic } from "./Snapshot.ts"

export type Tone = "green" | "yellow" | "red" | "purple" | "gray"

export interface Appearance {
  readonly tone: Tone
  readonly label: string
  readonly strikethrough: boolean
  readonly stale: boolean
}

type Open = Extract<PullRequestState, { readonly _tag: "Open" }>

const diagnosticLabels: Record<Diagnostic, string> = {
  AuthenticationRequired: "authenticate",
  GitHubCliMissing: "install gh",
  GitHubUnavailable: "GitHub unavailable",
  InvalidResponse: "invalid response",
  NotFound: "inaccessible",
  RateLimited: "rate limited",
}

const shown = (tone: Tone, label: string, strikethrough = false): Appearance => ({
  label,
  stale: false,
  strikethrough,
  tone,
})

/** How near a pull request with no conflict or failed CI, and not a draft, is to merging. */
function readiness(open: Open): Appearance {
  if (open.ci === "unknown") return shown("gray", "checks unknown")

  if (open.ci === "pending") return shown("yellow", "pending")

  if (open.behind === "unknown") return shown("gray", "merge state unknown")

  if (open.behind) return shown("yellow", "behind")

  return open.ci === "passed" ? shown("green", "passed") : shown("gray", "no checks")
}

/**
 * Precedence: conflict, failed CI, draft, unknown or pending CI, behind or an unknown merge state,
 * then passed or no checks.
 */
function openAppearance(open: Open): Appearance {
  if (open.mergeability === "conflicting") return shown("red", "conflict")

  if (open.ci === "failed") return shown("red", "failed")

  return open.draft ? shown("gray", "draft") : readiness(open)
}

function stateAppearance(state: PullRequestState): Appearance {
  return PullRequestState.match(state, {
    Closed: () => shown("red", "closed", true),
    Merged: () => shown("purple", "merged", true),
    Open: openAppearance,
  })
}

function markStale(fresh: Appearance): Appearance {
  return { label: fresh.label, stale: true, strikethrough: fresh.strikethrough, tone: fresh.tone }
}

export function appearance(status: Status): Appearance {
  return Status.match(status, {
    Fresh: ({ snapshot }) => stateAppearance(snapshot.state),
    Pending: () => shown("gray", "loading"),
    Stale: ({ snapshot }) => markStale(stateAppearance(snapshot.state)),
    Unavailable: ({ diagnostic }) => shown("gray", diagnosticLabels[diagnostic]),
  })
}
