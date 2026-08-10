import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ToolContext } from "@opencode-ai/plugin"

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
    const args = { url: "https://github.com/owner/repository/pull/2" }
    await tools.pr_attach!.execute(args, context("session"))

    expect(await tools.pr_detach!.execute(args, context("session"))).toBe(
      "Detached owner/repository#2 from this session.",
    )
    expect(await tools.pr_detach!.execute(args, context("session"))).toBe(
      "owner/repository#2 is not attached to this session.",
    )
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
