import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { tool, type ToolContext } from "@opencode-ai/plugin"

import serverModule, { createServerHooks, PrToolError } from "../src/server.js"
import { createStateStore } from "../src/state.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-server-"))
  directories.push(directory)
  const store = createStateStore({ directory, now: () => new Date("2026-08-10T12:00:00.000Z") })
  const hooks = createServerHooks(store)
  return { store, tools: hooks.tool! }
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

describe("server tools", () => {
  test("exports the v1 server plugin module shape", () => {
    expect(serverModule).toMatchObject({
      id: "opencode-pr-tracker",
      server: expect.any(Function),
    })
  })

  test("attaches idempotently to the invoking session only", async () => {
    const { store, tools } = await setup()

    expect(
      await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/1" }, context("session-one")),
    ).toBe("Attached owner/repository#1 to this session.")
    expect(
      await tools.pr_attach!.execute({ url: "https://github.com/owner/repository/pull/1" }, context("session-one")),
    ).toBe("owner/repository#1 is already attached to this session.")

    const first = await store.list("session-one")
    const second = await store.list("session-two")
    expect(first.ok && first.value.map((item) => item.pullRequest.number)).toEqual([1])
    expect(second).toEqual({ ok: true, value: [] })
  })

  test("detaches idempotently from the invoking session", async () => {
    const { tools } = await setup()
    const url = "https://github.com/owner/repository/pull/2"
    await tools.pr_attach!.execute({ url }, context("session"))

    expect(await tools.pr_detach!.execute({ pull_request: url }, context("session"))).toBe(
      "Detached owner/repository#2 from this session.",
    )
    expect(await tools.pr_detach!.execute({ pull_request: url }, context("session"))).toBe(
      "owner/repository#2 is not attached to this session.",
    )
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
      new PrToolError("InvalidPullRequestNumber", "Expected a positive pull request number or canonical GitHub URL"),
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
        "Expected https://github.com/<owner>/<repository>/pull/<positive-integer>",
      ),
    )
  })
})
