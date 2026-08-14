const CLAIM = "CLAIM"
const UNCLAIM = "UNCLAIM"
const CLEAR = "CLEAR"
const COMMANDS = new Set([CLAIM, UNCLAIM, CLEAR])
const CLEAR_PERMISSIONS = new Set(["write", "maintain", "admin"])
const AUTHORIZATION_REACTION = "eyes"
const ACTIONS_BOT = "github-actions[bot]"

/**
 * @typedef {{ event: "commented", id: number, body: string, created_at: string, updated_at: string, user: { login: string } | null }} CommentEvent
 * @typedef {{ event: "assigned" | "unassigned", id: number, created_at: string, assignee: { login: string } | null }} AssignmentEvent
 * @typedef {CommentEvent | AssignmentEvent | { event: string, id: number, created_at: string }} TimelineEvent
 */

/**
 * @param {{
 *   events: TimelineEvent[],
 * }} input
 * @returns {Promise<string[]>}
 */
export async function resolveIssueClaim({ events }) {
  const assignees = new Set()
  let owner

  for (const event of events) {
    if (event.event === "assigned") {
      const login = event.assignee?.login
      if (!login) continue

      const wasUnassigned = assignees.size === 0
      assignees.add(login)
      if (wasUnassigned) owner = login
      continue
    }

    if (event.event === "unassigned") {
      const login = event.assignee?.login
      if (!login) continue

      assignees.delete(login)
      if (owner === login) owner = undefined
      if (owner === undefined && assignees.size === 1) owner = assignees.values().next().value
      continue
    }

    if (event.event !== "commented" || event.updated_at !== event.created_at) continue

    const login = event.user?.login
    if (!login) continue

    if (event.body === CLAIM) {
      if (assignees.size > 0) continue

      assignees.add(login)
      owner = login
      continue
    }

    if (event.body === UNCLAIM && owner === login) {
      assignees.delete(login)
      owner = assignees.size === 1 ? assignees.values().next().value : undefined
      continue
    }

    if (event.body === CLEAR) {
      assignees.clear()
      owner = undefined
    }
  }

  return [...assignees]
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404
}

/**
 * @param {{ github: any, context: any }} input
 * @returns {Promise<boolean>}
 */
export async function authorizeIssueCommand({ github, context }) {
  const issue = context.payload.issue
  const comment = context.payload.comment
  const command = comment?.body
  const login = comment?.user?.login
  if (!issue || issue.pull_request || !COMMANDS.has(command) || !login) return false

  const { owner, repo } = context.repo
  let allowed = command === UNCLAIM
  if (command === CLAIM) {
    try {
      await github.rest.issues.checkUserCanBeAssigned({ owner, repo, assignee: login })
      allowed = true
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  } else if (command === CLEAR) {
    try {
      const response = await github.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: login,
      })
      allowed = CLEAR_PERMISSIONS.has(response.data.permission)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  if (!allowed) return false

  await github.rest.reactions.createForIssueComment({
    owner,
    repo,
    comment_id: comment.id,
    content: AUTHORIZATION_REACTION,
  })
  return true
}

/**
 * @param {any} github
 * @param {{ owner: string, repo: string }} repo
 * @param {number} commentId
 * @returns {Promise<boolean>}
 */
async function isAuthorizedCommand(github, repo, commentId) {
  const reactions = await github.paginate(github.rest.reactions.listForIssueComment, {
    ...repo,
    comment_id: commentId,
    per_page: 100,
  })
  return reactions.some(
    (reaction) => reaction.content === AUTHORIZATION_REACTION && reaction.user?.login === ACTIONS_BOT,
  )
}

/**
 * @param {{ github: any, context: any }} input
 * @returns {Promise<void>}
 */
export async function reconcileIssueClaim({ github, context }) {
  const issue = context.payload.issue
  const command = context.payload.comment?.body
  if (!issue || issue.pull_request || !COMMANDS.has(command)) return

  const { owner, repo } = context.repo
  const issueNumber = context.issue.number
  const request = { owner, repo, issue_number: issueNumber }
  const issueResponse = await github.rest.issues.get(request)
  const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
    ...request,
    per_page: 100,
  })
  const current = issueResponse.data.assignees
    .map((assignee) => assignee.login)
    .filter((login) => typeof login === "string")
  const authorizedEvents = []
  for (const event of events) {
    if (event.event !== "commented") {
      authorizedEvents.push(event)
      continue
    }
    if (
      event.updated_at === event.created_at &&
      COMMANDS.has(event.body) &&
      (await isAuthorizedCommand(github, { owner, repo }, event.id))
    ) {
      authorizedEvents.push(event)
    }
  }
  const target = await resolveIssueClaim({ events: authorizedEvents })
  const additions = target.filter((login) => !current.includes(login))
  const removals = current.filter((login) => !target.includes(login))
  if (additions.length > 0) {
    await github.rest.issues.addAssignees({ ...request, assignees: additions })
  }
  if (removals.length > 0) {
    await github.rest.issues.removeAssignees({ ...request, assignees: removals })
  }
}
