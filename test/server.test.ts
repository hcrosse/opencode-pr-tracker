import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { tool, type Hooks, type ToolContext } from "@opencode-ai/plugin"

import serverModule, { createServerHooks, PrToolError, readFeedbackDiagnostics } from "../src/server.js"
import { FeedbackToolError } from "../src/feedback-tool.js"
import type { GitHubClient } from "../src/github.js"
import { createStateStore } from "../src/state.js"
import { parsePullRequestUrl, type PullRequestUrl } from "../src/url.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function availableGitHub(): GitHubClient {
  return {
    async getStack(requested) {
      return { ok: true, value: [requested] }
    },
    async getStacks(requested) {
      return {
        ok: true,
        value: requested.map((pullRequest) => ({
          ok: true,
          value: { tag: "Standalone", pullRequest },
        })),
      }
    },
    async get(pullRequests) {
      return {
        ok: true,
        value: pullRequests.map((pullRequest) => ({
          ok: true,
          value: {
            tag: "Available",
            pullRequest,
            title: "Pull request",
            state: { tag: "Open", ci: "none", isDraft: false, mergeability: "unknown", blocker: "none" },
            stale: false,
          },
        })),
      }
    },
  }
}

function stackPullRequest(number: number): PullRequestUrl {
  const parsed = parsePullRequestUrl(`https://github.com/owner/repository/pull/${number}`)
  if (!parsed.ok) throw new Error("test fixture URL is invalid")
  return parsed.value
}

async function setup(github: GitHubClient = availableGitHub()) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-server-"))
  directories.push(directory)
  const store = createStateStore({ directory, now: () => new Date("2026-08-10T12:00:00.000Z") })
  const hooks = createServerHooks(store, github, {
    createPreviewID: () => "preview-1",
    async readDiagnostics() {
      return {
        pluginVersion: "0.3.0",
        opencodeVersion: "1.18.15",
        operatingSystem: "darwin/arm64",
      }
    },
    platform: "darwin",
    runner: async () => ({ stdout: "" }),
  })
  return { directory, hooks, store, tools: hooks.tool! }
}

function context(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "message",
    agent: "build",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

function sessionDeleted(sessionID: string): Parameters<NonNullable<Hooks["event"]>>[0] {
  return {
    event: {
      type: "session.deleted",
      properties: {
        info: {
          id: sessionID,
          projectID: "project",
          directory: "/project",
          title: "Session",
          version: "1",
          time: { created: 1, updated: 1 },
        },
      },
    },
  }
}

describe("server tools", () => {
  test("exports the v1 server plugin module shape", () => {
    expect(serverModule).toMatchObject({
      id: "opencode-pr-tracker",
      server: expect.any(Function),
    })
  })

  test("keeps the GitHub client optional for createServerHooks callers", () => {
    expect(createServerHooks.length).toBe(1)
  })

  test("registers the agent-facing feedback tool", async () => {
    const { tools } = await setup()

    expect(tools).toHaveProperty("pr_feedback")
  })

  test("attaches idempotently to the invoking session only", async () => {
    const { store, tools } = await setup()

    expect(await tools.pr_attach!.execute({ url: "github.com/Owner/Repository/pull/1" }, context("session-one"))).toBe(
      "Attached owner/repository#1 to this session.",
    )
    expect(
      await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/1" }, context("session-one")),
    ).toBe("owner/repository#1 is already attached to this session.")

    const attachments = await store.list("session-one")
    expect(attachments.ok && String(attachments.value[0]?.pullRequest.url)).toBe(
      "https://github.com/owner/repository/pull/1",
    )
    expect(await tools.pr_list!.execute({}, context("session-one"))).toBe(
      "Attached pull requests:\n- https://github.com/owner/repository/pull/1",
    )

    const first = attachments
    const second = await store.list("session-two")
    expect(first.ok && first.value.map((item) => item.pullRequest.number)).toEqual([1])
    expect(second).toEqual({ ok: true, value: [] })
  })

  test("surfaces a missing pull request without mutating session state", async () => {
    let requestSignal: AbortSignal | undefined
    const github: GitHubClient = {
      ...availableGitHub(),
      async getStack(_requested, options) {
        requestSignal = options?.signal
        return {
          ok: false,
          error: {
            tag: "PullRequestNotFound",
            message: "Pull request does not exist or is not accessible",
          },
        }
      },
    }
    const { store, tools } = await setup(github)
    const toolContext = context("session")

    expect(
      tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/404" }, toolContext),
    ).rejects.toEqual(new PrToolError("PullRequestNotFound", "Pull request does not exist or is not accessible"))
    expect(requestSignal).toBe(toolContext.abort)
    expect(await store.list("session")).toEqual({ ok: true, value: [] })
  })

  test("reports when the invoking session has no attached pull requests", async () => {
    const { tools } = await setup()

    expect(await tools.pr_list!.execute({}, context("session"))).toBe("No pull requests are attached to this session.")
  })

  test("lists canonical pull request URLs in attachment order for the invoking session", async () => {
    const { tools } = await setup()
    await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/2" }, context("session"))
    await tools.pr_attach!.execute({ url: "https://github.com/another/project/pull/1" }, context("session"))
    await tools.pr_attach!.execute({ url: "https://github.com/other/session/pull/3" }, context("other-session"))

    expect(await tools.pr_list!.execute({}, context("session"))).toBe(
      "Attached pull requests:\n" +
        "- https://github.com/owner/repository/pull/2\n" +
        "- https://github.com/another/project/pull/1",
    )
  })

  test("translates list state failures into structured tool errors", async () => {
    const { directory, tools } = await setup()
    await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/1" }, context("session"))
    const [stateFile] = await readdir(directory)
    if (stateFile === undefined) throw new Error("expected state file")
    await writeFile(join(directory, stateFile), `${JSON.stringify({ version: 2, pullRequests: [] })}\n`)

    expect(tools.pr_list!.execute({}, context("session"))).rejects.toEqual(
      new PrToolError("InvalidStateFile", "The session pull request state file is invalid"),
    )
  })

  test("removes only the deleted session state", async () => {
    const { hooks, store, tools } = await setup()
    await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/1" }, context("deleted"))
    await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/2" }, context("active"))
    const preview = await tools.pr_feedback!.execute(
      {
        request: {
          action: "preview",
          feedback: { kind: "other", title: "Feedback", details: "Details" },
          include_diagnostics: false,
        },
      },
      context("deleted"),
    )
    if (typeof preview !== "string") throw new Error("expected feedback preview")
    const previewID = preview.match(/Preview ID: (.+)$/)?.[1]
    if (previewID === undefined) throw new Error("expected feedback preview ID")

    await hooks.event!(sessionDeleted("deleted"))

    expect(await store.list("deleted")).toEqual({ ok: true, value: [] })
    const active = await store.list("active")
    expect(active.ok && active.value.map((item) => item.pullRequest.number)).toEqual([2])
    expect(
      tools.pr_feedback!.execute(
        {
          request: {
            action: "deliver",
            preview_id: previewID,
            delivery: "browser",
            approval: "approved_via_question",
          },
        },
        context("deleted"),
      ),
    ).rejects.toEqual(new FeedbackToolError("FeedbackPreviewNotFound", "Preview feedback again before delivery"))
  })

  test("surfaces corrupt state without removing it on session deletion", async () => {
    const { directory, hooks, tools } = await setup()
    await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/1" }, context("session"))
    const [stateFile] = await readdir(directory)
    if (stateFile === undefined) throw new Error("expected state file")
    await writeFile(join(directory, stateFile), `${JSON.stringify({ version: 2, pullRequests: [] })}\n`)

    expect(hooks.event!(sessionDeleted("session"))).rejects.toEqual(
      new PrToolError("InvalidStateFile", "The session pull request state file is invalid"),
    )
    expect(await readdir(directory)).toEqual([stateFile])
  })

  test("detaches idempotently from the invoking session", async () => {
    const { tools } = await setup()
    const url = "https://github.com/owner/repository/pull/2"
    await tools.pr_attach!.execute({ url }, context("session"))

    expect(
      await tools.pr_detach!.execute({ pull_request: "github.com/owner/repository/pull/2" }, context("session")),
    ).toBe("Detached owner/repository#2 from this session.")
    expect(await tools.pr_detach!.execute({ pull_request: url }, context("session"))).toBe(
      "owner/repository#2 is not attached to this session.",
    )
  })

  test("detaches only the explicitly selected member of an attached stack", async () => {
    const stack = [stackPullRequest(1), stackPullRequest(2), stackPullRequest(3)] as const
    const github: GitHubClient = {
      async getStack() {
        return { ok: true, value: stack }
      },
      async getStacks(requested) {
        return {
          ok: true,
          value: requested.map((pullRequest) => ({
            ok: true,
            value: { tag: "Standalone", pullRequest },
          })),
        }
      },
      async get() {
        throw new Error("status lookup is not expected")
      },
    }
    const { store, tools } = await setup(github)
    const session = context("session")
    await tools.pr_attach!.execute({ url: stack[1].url }, session)

    expect(await tools.pr_detach!.execute({ pull_request: stack[1].url }, session)).toBe(
      "Detached owner/repository#2 from this session.",
    )
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.number)).toEqual([1, 3])
  })

  test("detaches a unique session attachment by pull request number", async () => {
    const { tools } = await setup()
    await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/2" }, context("session"))

    expect(await tools.pr_detach!.execute({ pull_request: 2 }, context("session"))).toBe(
      "Detached owner/repository#2 from this session.",
    )
    expect(await tools.pr_detach!.execute({ pull_request: 2 }, context("session"))).toBe(
      "Pull request #2 is not attached to this session.",
    )
  })

  test("rejects ambiguous pull request numbers without detaching", async () => {
    const { store, tools } = await setup()
    const session = context("session")
    await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/2" }, session)
    await tools.pr_attach!.execute({ url: "https://github.com/another/project/pull/2" }, session)

    expect(tools.pr_detach!.execute({ pull_request: 2 }, session)).rejects.toEqual(
      new PrToolError(
        "AmbiguousPullRequestNumber",
        "Pull request #2 matches owner/repository#2 and another/project#2. Use a canonical GitHub pull request URL.",
      ),
    )
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value).toHaveLength(2)
  })

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid pull request number %s", async (number) => {
    const { tools } = await setup()

    expect(tools.pr_detach!.execute({ pull_request: number }, context("session"))).rejects.toEqual(
      new PrToolError(
        "InvalidPullRequestNumber",
        "Expected 123, https://github.com/owner/repository/pull/123, or github.com/owner/repository/pull/123",
      ),
    )
  })

  test("advertises only positive safe integers or URL strings for detach", async () => {
    const { tools } = await setup()
    const schema = tool.schema.object(tools.pr_detach!.args)

    expect(schema.safeParse({ pull_request: 1 }).success).toBe(true)
    expect(schema.safeParse({ pull_request: "https://github.com/owner/repository/pull/1" }).success).toBe(true)
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(schema.safeParse({ pull_request: value }).success).toBe(false)
    }
  })

  test("translates invalid input into a structured tool error", async () => {
    const { tools } = await setup()

    expect(tools.pr_attach!.execute({ url: "https://example.com/pull/1" }, context("session"))).rejects.toEqual(
      new PrToolError(
        "InvalidPullRequestUrl",
        "Expected https://github.com/<owner>/<repository>/pull/<positive-integer> or github.com/<owner>/<repository>/pull/<positive-integer>",
      ),
    )
  })
})

describe("feedback diagnostics", () => {
  const serverUrl = new URL("http://127.0.0.1:4096")

  test("reads the OpenCode version from the local health endpoint", async () => {
    let requestUrl: string | undefined
    let requestSignal: AbortSignal | undefined
    const signal = new AbortController().signal

    const result = await readFeedbackDiagnostics(serverUrl, {
      pluginVersion: "0.3.0",
      platform: "darwin",
      arch: "arm64",
      signal,
      fetcher: async (input, init) => {
        requestUrl = String(input)
        requestSignal = init?.signal ?? undefined
        return Response.json({ healthy: true, version: "1.18.15" })
      },
    })

    expect(requestUrl).toBe("http://127.0.0.1:4096/global/health")
    expect(requestSignal).toBe(signal)
    expect(result).toEqual({
      pluginVersion: "0.3.0",
      opencodeVersion: "1.18.15",
      operatingSystem: "darwin/arm64",
    })
  })

  test.each([
    {
      name: "non-OK response",
      fetcher: async () => new Response("unavailable", { status: 503 }),
    },
    {
      name: "malformed response",
      fetcher: async () => Response.json({ healthy: true, version: 11815 }),
    },
    {
      name: "request failure",
      fetcher: async () => {
        throw new Error("connection failed")
      },
    },
  ])("uses an unavailable OpenCode version after a $name", async ({ fetcher }) => {
    expect(
      await readFeedbackDiagnostics(serverUrl, {
        pluginVersion: "0.3.0",
        platform: "linux",
        arch: "x64",
        signal: new AbortController().signal,
        fetcher,
      }),
    ).toEqual({
      pluginVersion: "0.3.0",
      opencodeVersion: "unavailable",
      operatingSystem: "linux/x64",
    })
  })

  test("preserves health request cancellation", async () => {
    const controller = new AbortController()
    const cancelled = new DOMException("cancelled", "AbortError")
    controller.abort(cancelled)

    expect(
      readFeedbackDiagnostics(serverUrl, {
        pluginVersion: "0.3.0",
        platform: "darwin",
        arch: "arm64",
        signal: controller.signal,
        fetcher: async () => {
          throw cancelled
        },
      }),
    ).rejects.toBe(cancelled)
  })
})
