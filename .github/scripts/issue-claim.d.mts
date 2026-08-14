export type IssueClaimCommentEvent = {
  event: "commented"
  id: number
  body: string
  created_at: string
  updated_at: string
  user: { login: string } | null
}

export type IssueClaimAssignmentEvent = {
  event: "assigned" | "unassigned"
  id: number
  created_at: string
  assignee: { login: string } | null
  actor: { login: string } | null
}

export type IssueClaimTimelineEvent =
  | IssueClaimCommentEvent
  | IssueClaimAssignmentEvent
  | { event: string; id: number; created_at: string }

export function resolveIssueClaim(input: { events: IssueClaimTimelineEvent[] }): Promise<string[]>

export function authorizeIssueCommand(input: { github: unknown; context: unknown }): Promise<boolean>

export function reconcileIssueClaim(input: { github: unknown; context: unknown }): Promise<void>
