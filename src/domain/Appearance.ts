import { Match } from "effect"

import type { Diagnostic, PullRequestState, Status } from "./Snapshot.ts"

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
}

const shown = (tone: Tone, label: string, strikethrough = false): Appearance => ({
  label,
  stale: false,
  strikethrough,
  tone,
})

/** Precedence: conflict, failed CI, draft, pending CI, behind, then passed or no checks. */
function openAppearance(open: Open): Appearance {
  if (open.mergeability === "conflicting") return shown("red", "conflict")

  if (open.ci === "failed") return shown("red", "failed")

  if (open.draft) return shown("gray", "draft")

  if (open.ci === "pending") return shown("yellow", "pending")

  if (open.behind) return shown("yellow", "behind")

  return open.ci === "passed" ? shown("green", "passed") : shown("gray", "no checks")
}

function stateAppearance(state: PullRequestState): Appearance {
  return Match.valueTags(state, {
    Closed: () => shown("red", "closed", true),
    Merged: () => shown("purple", "merged", true),
    Open: openAppearance,
  })
}

function markStale(fresh: Appearance): Appearance {
  return { label: fresh.label, stale: true, strikethrough: fresh.strikethrough, tone: fresh.tone }
}

export function appearance(status: Status): Appearance {
  return Match.valueTags(status, {
    Fresh: ({ snapshot }) => stateAppearance(snapshot.state),
    Pending: () => shown("gray", "unavailable"),
    Stale: ({ snapshot }) => markStale(stateAppearance(snapshot.state)),
    Unavailable: ({ diagnostic }) => shown("gray", diagnosticLabels[diagnostic]),
  })
}
