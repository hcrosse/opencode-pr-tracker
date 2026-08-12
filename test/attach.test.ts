import { describe, expect, test } from "bun:test"

import { attachPullRequest, resolvePullRequestInput } from "../src/attach.js"
import type { GitHubClient, ProcessRunner } from "../src/github.js"
import type { PullRequestAttachment, StateStore } from "../src/state.js"
import { parsePullRequestUrl } from "../src/url.js"

type ProcessCall = Readonly<{
  file: string
  args: readonly string[]
  options: Readonly<{ signal?: AbortSignal; cwd?: string }>
}>

function recordingRunner(stdout: string, calls: ProcessCall[]): ProcessRunner {
  return async (file, args, options) => {
    calls.push({ file, args, options })
    return { stdout }
  }
}

describe("attachPullRequest", () => {
  test("returns a missing pull request failure without mutating state", async () => {
    const parsed = parsePullRequestUrl("https://github.com/owner/repository/pull/404")
    if (!parsed.ok) throw new Error("test fixture URL is invalid")
    const attachments: PullRequestAttachment[] = []
    const store: StateStore = {
      async list() {
        return { ok: true, value: attachments }
      },
      async attach(_sessionID, pullRequest) {
        attachments.push({ pullRequest, attachedAt: "2026-08-10T12:00:00.000Z" })
        return { ok: true, value: "added" }
      },
      async detach() {
        return { ok: true, value: "absent" }
      },
      async detachByNumber() {
        return { ok: true, value: { tag: "absent" } }
      },
      async removeSession() {
        return { ok: true, value: "absent" }
      },
    }
    let requestSignal: AbortSignal | undefined
    const github: GitHubClient = {
      async get(_pullRequests, options) {
        requestSignal = options?.signal
        return {
          ok: true,
          value: [
            {
              ok: false,
              error: {
                tag: "PullRequestNotFound",
                message: "Pull request does not exist or is not accessible",
              },
            },
          ],
        }
      },
    }
    const signal = new AbortController().signal

    expect(await attachPullRequest({ store, github }, "session", parsed.value, { signal })).toEqual({
      ok: false,
      error: {
        tag: "PullRequestNotFound",
        message: "Pull request does not exist or is not accessible",
      },
    })
    expect(requestSignal).toBe(signal)
    expect(await store.list("session")).toEqual({ ok: true, value: [] })
  })
})

describe("resolvePullRequestInput", () => {
  test("returns a canonical URL without repository discovery", async () => {
    const calls: ProcessCall[] = []

    const result = await resolvePullRequestInput("https://github.com/owner/repo/pull/7", {
      directory: "/project",
      runner: recordingRunner("", calls),
    })

    expect(result).toMatchObject({
      ok: true,
      value: { owner: "owner", repository: "repo", number: 7 },
    })
    expect(calls).toEqual([])
  })

  test("resolves a positive number against the current GitHub repository", async () => {
    const calls: ProcessCall[] = []
    const signal = new AbortController().signal

    const result = await resolvePullRequestInput("00042", {
      directory: "/project",
      runner: recordingRunner('{"url":"https://github.com/owner/repo"}', calls),
      signal,
    })

    expect(result).toMatchObject({
      ok: true,
      value: { url: "https://github.com/owner/repo/pull/42", number: 42 },
    })
    expect(calls).toEqual([
      {
        file: "gh",
        args: ["repo", "view", "--json", "url"],
        options: { cwd: "/project", signal },
      },
    ])
  })

  test.each([" 42", "42 ", "+42", "-1", "0", "1.5", "9007199254740992"])(
    "rejects invalid numeric input %s without repository discovery",
    async (input) => {
      const calls: ProcessCall[] = []

      expect(
        await resolvePullRequestInput(input, {
          directory: "/project",
          runner: recordingRunner("", calls),
        }),
      ).toEqual({
        ok: false,
        error: {
          tag: "InvalidPullRequestInput",
          message:
            "Expected https://github.com/<owner>/<repository>/pull/<positive-integer> or a positive pull request number",
        },
      })
      expect(calls).toEqual([])
    },
  )

  test("returns an actionable failure when repository discovery fails", async () => {
    const cause = new Error("gh failed")
    const runner: ProcessRunner = async () => {
      throw cause
    }

    expect(await resolvePullRequestInput("42", { directory: "/project", runner })).toEqual({
      ok: false,
      error: {
        tag: "RepositoryResolutionFailed",
        message: "Unable to resolve the current GitHub repository with gh; attach with a full URL instead",
        cause,
      },
    })
  })

  test.each(["not json", "{}", '{"url":"https://example.com/owner/repo"}'])(
    "rejects malformed repository output %s",
    async (stdout) => {
      expect(
        await resolvePullRequestInput("42", {
          directory: "/project",
          runner: recordingRunner(stdout, []),
        }),
      ).toEqual({
        ok: false,
        error: {
          tag: "RepositoryResolutionFailed",
          message: "Unable to resolve the current GitHub repository with gh; attach with a full URL instead",
        },
      })
    },
  )

  test("classifies cancellation before repository failure", async () => {
    const controller = new AbortController()
    controller.abort()
    const cause = new Error("aborted")
    cause.name = "AbortError"
    const runner: ProcessRunner = async () => {
      throw cause
    }

    expect(
      await resolvePullRequestInput("42", {
        directory: "/project",
        runner,
        signal: controller.signal,
      }),
    ).toEqual({ ok: false, error: { tag: "RepositoryResolutionCancelled" } })
  })
})
