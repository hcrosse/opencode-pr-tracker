import { describe, expect, test } from "bun:test"

import { resolvePullRequestInput } from "../src/attach.js"
import type { ProcessRunner } from "../src/github.js"

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
