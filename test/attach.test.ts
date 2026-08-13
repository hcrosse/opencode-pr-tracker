import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { attachPullRequest, resolvePullRequestInput } from "../src/attach.js"
import type { GitHubClient, ProcessRunner } from "../src/github.js"
import { createStateStore } from "../src/state.js"
import { parsePullRequestUrl, type PullRequestUrl } from "../src/url.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryStateStore() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-attach-"))
  directories.push(directory)
  return createStateStore({ directory })
}

function pullRequest(number: number): PullRequestUrl {
  const parsed = parsePullRequestUrl(`https://github.com/owner/repository/pull/${number}`)
  if (!parsed.ok) throw new Error("test fixture URL is invalid")
  return parsed.value
}

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function availableGitHubItem(value: PullRequestUrl) {
  return {
    ok: true,
    value: {
      tag: "Available",
      pullRequest: value,
      title: "Pull request",
      state: { tag: "Open", ci: "none", mergeability: "unknown", blocker: "none" },
      stale: false,
    },
  } as const
}

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
    const store = await temporaryStateStore()
    const requested = pullRequest(404)
    let requestSignal: AbortSignal | undefined
    const github: GitHubClient = {
      async getStack(value) {
        return { ok: true, value: [value] }
      },
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

    expect(await attachPullRequest({ store, github }, "session", requested, { signal })).toEqual({
      ok: false,
      error: {
        tag: "PullRequestNotFound",
        message: "Pull request does not exist or is not accessible",
      },
    })
    expect(requestSignal).toBe(signal)
    expect(await store.list("session")).toEqual({ ok: true, value: [] })
  })

  test("serializes validation and attachment in same-session FIFO order", async () => {
    const store = await temporaryStateStore()
    const firstValidationStarted = deferred()
    const releaseFirstValidation = deferred()
    const validationStarts: number[] = []
    const github: GitHubClient = {
      async getStack(value) {
        return { ok: true, value: [value] }
      },
      async get(pullRequests, _options) {
        const requested = pullRequests[0]
        if (requested === undefined) throw new Error("expected one pull request")
        validationStarts.push(requested.number)
        if (requested.number === 1) {
          firstValidationStarted.resolve()
          await releaseFirstValidation.promise
        }
        return { ok: true, value: [availableGitHubItem(requested)] }
      },
    }

    const first = attachPullRequest({ store, github }, "session", pullRequest(1))
    await firstValidationStarted.promise
    const second = attachPullRequest({ store, github }, "session", pullRequest(2))
    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })
    await Promise.resolve()

    expect(validationStarts).toEqual([1])
    expect(secondSettled).toBe(false)
    releaseFirstValidation.resolve()

    expect(await Promise.all([first, second])).toEqual([
      { ok: true, value: "added" },
      { ok: true, value: "added" },
    ])
    expect(validationStarts).toEqual([1, 2])
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.number)).toEqual([1, 2])
  })

  test("returns already attached without contacting GitHub", async () => {
    const store = await temporaryStateStore()
    const requested = pullRequest(1)
    await store.attach("session", requested)
    let githubCalls = 0
    const github: GitHubClient = {
      async getStack(value) {
        return { ok: true, value: [value] }
      },
      async get() {
        githubCalls += 1
        throw new Error("GitHub must not be called for an existing attachment")
      },
    }

    expect(await attachPullRequest({ store, github }, "session", requested)).toEqual({
      ok: true,
      value: "already_attached",
    })
    expect(githubCalls).toBe(0)
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.number)).toEqual([1])
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

  test("returns a canonical URL for scheme-less input without repository discovery", async () => {
    const calls: ProcessCall[] = []
    const result = await resolvePullRequestInput("github.com/Owner/Repo/pull/7", {
      directory: "/project",
      runner: recordingRunner("", calls),
    })

    expect(result).toMatchObject({
      ok: true,
      value: { url: "https://github.com/owner/repo/pull/7", number: 7 },
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
            "Expected https://github.com/<owner>/<repository>/pull/<positive-integer>, github.com/<owner>/<repository>/pull/<positive-integer>, or a positive pull request number",
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
