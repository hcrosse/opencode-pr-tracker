import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { authorizeIssueCommand, reconcileIssueClaim, resolveIssueClaim } from "../.github/scripts/issue-claim.mjs"

type CommentEvent = {
  event: "commented"
  id: number
  body: string
  created_at: string
  updated_at: string
  user: { login: string }
}

type AssignmentEvent = {
  event: "assigned" | "unassigned"
  id: number
  created_at: string
  assignee: { login: string }
  actor: { login: string }
}

type TimelineEvent = CommentEvent | AssignmentEvent

function timestamp(id: number): string {
  return `2026-08-14T00:00:${String(id).padStart(2, "0")}Z`
}

function comment(id: number, body: string, login: string, edited = false): CommentEvent {
  return {
    event: "commented",
    id,
    body,
    created_at: timestamp(id),
    updated_at: edited ? "2026-08-14T01:00:00Z" : timestamp(id),
    user: { login },
  }
}

function assignment(id: number, event: "assigned" | "unassigned", login: string, actor = "hcrosse"): AssignmentEvent {
  return {
    event,
    id,
    created_at: timestamp(id),
    assignee: { login },
    actor: { login: actor },
  }
}

function authorization(id: number, commentId: number): CommentEvent {
  return comment(id, `<!-- issue-claim:authorized:${commentId} -->`, "github-actions[bot]")
}

function resolve(events: TimelineEvent[]): Promise<string[]> {
  return resolveIssueClaim({ events })
}

describe("resolveIssueClaim", () => {
  test("preserves the earliest eligible claim", async () => {
    expect(await resolve([comment(1, "CLAIM", "alice"), comment(2, "CLAIM", "bob")])).toEqual(["alice"])
  })

  test("requires an exact unedited command", async () => {
    expect(
      await resolve([
        comment(1, " CLAIM", "alice"),
        comment(2, "CLAIMED", "bob"),
        comment(3, "claim", "alice"),
        comment(4, "CLAIM", "alice", true),
      ]),
    ).toEqual([])
  })

  test("only the owner can release a claim", async () => {
    expect(
      await resolve([comment(1, "CLAIM", "alice"), comment(2, "UNCLAIM", "bob"), comment(3, "UNCLAIM", "alice")]),
    ).toEqual([])
  })

  test("allows a new claim after release", async () => {
    expect(
      await resolve([comment(1, "CLAIM", "alice"), comment(2, "UNCLAIM", "alice"), comment(3, "CLAIM", "bob")]),
    ).toEqual(["bob"])
  })

  test("clears assignment for an authorized clear command", async () => {
    expect(await resolve([comment(1, "CLAIM", "alice"), comment(2, "CLEAR", "maintainer")])).toEqual([])
  })

  test("treats assignment as a claim and preserves unrelated assignees", async () => {
    expect(await resolve([assignment(1, "assigned", "carol"), comment(2, "CLAIM", "alice")])).toEqual(["carol"])
    expect(
      await resolve([comment(1, "CLAIM", "alice"), assignment(2, "assigned", "carol"), comment(3, "UNCLAIM", "alice")]),
    ).toEqual(["carol"])
  })

  test("preserves assignment added after a historical clear", async () => {
    expect(
      await resolve([
        comment(1, "CLAIM", "alice"),
        comment(2, "CLEAR", "maintainer"),
        assignment(3, "assigned", "carol"),
        comment(4, "CLAIM", "bob"),
      ]),
    ).toEqual(["carol"])
  })

  test("applies a coalesced clear before a later claim", async () => {
    expect(
      await resolve([
        assignment(1, "assigned", "carol"),
        comment(2, "CLEAR", "maintainer"),
        comment(3, "CLAIM", "bob"),
      ]),
    ).toEqual(["bob"])
  })

  test("preserves a same-user reassignment after clear", async () => {
    expect(
      await resolve([
        comment(1, "CLAIM", "alice"),
        comment(2, "CLEAR", "maintainer"),
        assignment(3, "assigned", "alice"),
        comment(4, "CLAIM", "bob"),
      ]),
    ).toEqual(["alice"])
  })

  test("promotes the remaining assignee when the owner is unassigned", async () => {
    expect(
      await resolve([
        assignment(1, "assigned", "alice"),
        assignment(2, "assigned", "carol"),
        assignment(3, "unassigned", "alice"),
        comment(4, "UNCLAIM", "carol"),
      ]),
    ).toEqual([])
  })

  test("promotes the final assignee after multiple unassignments", async () => {
    expect(
      await resolve([
        assignment(1, "assigned", "alice"),
        assignment(2, "assigned", "bob"),
        assignment(3, "assigned", "carol"),
        assignment(4, "unassigned", "alice"),
        assignment(5, "unassigned", "bob"),
        comment(6, "UNCLAIM", "carol"),
      ]),
    ).toEqual([])
  })

  test("preserves API order for events created in the same second", async () => {
    const clear = comment(99, "CLEAR", "maintainer")
    const assigned = assignment(1, "assigned", "carol")
    assigned.created_at = clear.created_at

    expect(await resolve([clear, assigned])).toEqual(["carol"])
  })
})

describe("authorizeIssueCommand", () => {
  test("rejects a claimant GitHub cannot assign", async () => {
    let marked = false
    const github = {
      rest: {
        issues: {
          checkUserCanBeAssigned: async () => {
            throw { status: 404 }
          },
          createComment: async () => {
            marked = true
          },
        },
        repos: {},
      },
    }
    const context = {
      repo: { owner: "hcrosse", repo: "opencode-pr-tracker" },
      payload: {
        comment: { id: 1, body: "CLAIM", user: { login: "mallory" } },
        issue: { number: 99 },
      },
    }

    expect(await authorizeIssueCommand({ github, context })).toBeFalse()
    expect(marked).toBeFalse()
  })

  test("marks an eligible claim as authorized", async () => {
    const markers: string[] = []
    const github = {
      rest: {
        issues: {
          checkUserCanBeAssigned: async () => ({ status: 204 }),
          createComment: async ({ body }: { body: string }) => {
            markers.push(body)
          },
        },
        repos: {},
      },
    }
    const context = {
      repo: { owner: "hcrosse", repo: "opencode-pr-tracker" },
      payload: {
        comment: { id: 1, body: "CLAIM", user: { login: "alice" } },
        issue: { number: 99 },
      },
    }

    expect(await authorizeIssueCommand({ github, context })).toBeTrue()
    expect(markers).toEqual(["<!-- issue-claim:authorized:1 -->"])
  })

  test("authorizes clear only with write permission", async () => {
    const markers: string[] = []
    let permission = "read"
    const github = {
      rest: {
        issues: {
          createComment: async ({ body }: { body: string }) => {
            markers.push(body)
          },
        },
        repos: {
          getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
        },
      },
    }
    const context = {
      repo: { owner: "hcrosse", repo: "opencode-pr-tracker" },
      payload: {
        comment: { id: 1, body: "CLEAR", user: { login: "maintainer" } },
        issue: { number: 99 },
      },
    }

    expect(await authorizeIssueCommand({ github, context })).toBeFalse()
    permission = "write"
    expect(await authorizeIssueCommand({ github, context })).toBeTrue()
    expect(markers).toEqual(["<!-- issue-claim:authorized:1 -->"])
  })
})

describe("reconcileIssueClaim", () => {
  test("paginates timeline events and updates assignment only when it changes", async () => {
    const events = [
      comment(1, "CLAIM", "alice"),
      authorization(11, 1),
      comment(2, "UNCLAIM", "alice"),
      authorization(12, 2),
      comment(3, "CLAIM", "bob"),
      authorization(13, 3),
    ]
    const state = { assignees: [] as string[] }
    const additions: string[][] = []
    const removals: string[][] = []
    const paginated: unknown[] = []
    const timelineEndpoint = Symbol("listEventsForTimeline")
    const github = {
      paginate: async (endpoint: unknown, options: unknown) => {
        paginated.push(endpoint, options)
        return events
      },
      rest: {
        issues: {
          listEventsForTimeline: timelineEndpoint,
          get: async () => ({ data: { assignees: state.assignees.map((login) => ({ login })) } }),
          addAssignees: async ({ assignees }: { assignees: string[] }) => {
            state.assignees.push(...assignees.filter((login) => !state.assignees.includes(login)))
            additions.push([...assignees])
          },
          removeAssignees: async ({ assignees }: { assignees: string[] }) => {
            state.assignees = state.assignees.filter((login) => !assignees.includes(login))
            removals.push([...assignees])
          },
        },
      },
    }
    const context = {
      repo: { owner: "hcrosse", repo: "opencode-pr-tracker" },
      issue: { number: 99 },
      payload: {
        comment: { id: 3, body: "CLAIM" },
        issue: { number: 99 },
      },
    }

    await reconcileIssueClaim({ github, context })
    await reconcileIssueClaim({ github, context })

    expect(paginated).toHaveLength(4)
    expect(additions).toEqual([["bob"]])
    expect(removals).toEqual([])
  })

  test("replays an authorized clear", async () => {
    const removals: string[][] = []
    const events = [assignment(1, "assigned", "alice"), comment(2, "CLEAR", "maintainer"), authorization(12, 2)]
    const timelineEndpoint = Symbol("listEventsForTimeline")
    const github = {
      paginate: async () => events,
      rest: {
        issues: {
          listEventsForTimeline: timelineEndpoint,
          get: async () => ({ data: { assignees: [{ login: "alice" }] } }),
          addAssignees: async () => undefined,
          removeAssignees: async ({ assignees }: { assignees: string[] }) => {
            removals.push([...assignees])
          },
        },
      },
    }
    const context = {
      repo: { owner: "hcrosse", repo: "opencode-pr-tracker" },
      issue: { number: 99 },
      payload: {
        comment: { id: 2, body: "CLEAR" },
        issue: { number: 99 },
      },
    }

    await reconcileIssueClaim({ github, context })

    expect(removals).toEqual([["alice"]])
  })

  test("ignores a delayed workflow assignment after unclaim", async () => {
    const removals: string[][] = []
    const events = [
      comment(1, "CLAIM", "alice"),
      authorization(11, 1),
      comment(2, "UNCLAIM", "alice"),
      authorization(12, 2),
      assignment(3, "assigned", "alice", "github-actions[bot]"),
    ]
    const github = {
      paginate: async () => events,
      rest: {
        issues: {
          listEventsForTimeline: Symbol("listEventsForTimeline"),
          get: async () => ({ data: { assignees: [{ login: "alice" }] } }),
          addAssignees: async () => undefined,
          removeAssignees: async ({ assignees }: { assignees: string[] }) => {
            removals.push([...assignees])
          },
        },
      },
    }
    const context = {
      repo: { owner: "hcrosse", repo: "opencode-pr-tracker" },
      issue: { number: 99 },
      payload: { comment: { id: 2, body: "UNCLAIM" }, issue: { number: 99 } },
    }

    await reconcileIssueClaim({ github, context })

    expect(removals).toEqual([["alice"]])
  })

  test("ignores a delayed workflow assignment for a losing claimant", async () => {
    const additions: string[][] = []
    const removals: string[][] = []
    const events = [
      comment(1, "CLAIM", "alice"),
      authorization(11, 1),
      comment(2, "CLAIM", "bob"),
      authorization(12, 2),
      assignment(3, "assigned", "bob", "github-actions[bot]"),
    ]
    const github = {
      paginate: async () => events,
      rest: {
        issues: {
          listEventsForTimeline: Symbol("listEventsForTimeline"),
          get: async () => ({ data: { assignees: [{ login: "bob" }] } }),
          addAssignees: async ({ assignees }: { assignees: string[] }) => {
            additions.push([...assignees])
          },
          removeAssignees: async ({ assignees }: { assignees: string[] }) => {
            removals.push([...assignees])
          },
        },
      },
    }
    const context = {
      repo: { owner: "hcrosse", repo: "opencode-pr-tracker" },
      issue: { number: 99 },
      payload: { comment: { id: 2, body: "CLAIM" }, issue: { number: 99 } },
    }

    await reconcileIssueClaim({ github, context })

    expect(additions).toEqual([["alice"]])
    expect(removals).toEqual([["bob"]])
  })

  test("ignores commands on pull request conversations", async () => {
    let requested = false
    const github = {
      paginate: async () => {
        requested = true
        return []
      },
      rest: { issues: {}, repos: {} },
    }
    const context = {
      repo: { owner: "hcrosse", repo: "opencode-pr-tracker" },
      issue: { number: 99 },
      payload: {
        comment: { id: 1, body: "CLAIM" },
        issue: { number: 99, pull_request: {} },
      },
    }

    await reconcileIssueClaim({ github, context })

    expect(requested).toBeFalse()
  })
})

test("issue claim workflow is narrow, serialized, and least privilege", async () => {
  const workflow = await readFile(new URL("../.github/workflows/issue-claim.yml", import.meta.url), "utf8")

  expect(workflow).toContain("issue_comment:")
  expect(workflow).toContain("types: [created]")
  expect(workflow).toContain("!github.event.issue.pull_request")
  expect(workflow).toContain("github.event.comment.body == 'CLAIM'")
  expect(workflow).toContain("github.event.comment.body == 'UNCLAIM'")
  expect(workflow).toContain("github.event.comment.body == 'CLEAR'")
  expect(workflow).toContain("contents: read")
  expect(workflow).toContain("issues: write")
  expect(workflow).toContain("authorizeIssueCommand")
  expect(workflow).toContain("needs: authorize")
  expect(workflow).toContain("needs.authorize.outputs.authorized == 'true'")
  expect(workflow).toContain("group: issue-claim-${{ github.event.issue.number }}")
  expect(workflow).toContain("cancel-in-progress: false")
  expect(workflow).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1")
  expect(workflow).toContain("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0")
})
