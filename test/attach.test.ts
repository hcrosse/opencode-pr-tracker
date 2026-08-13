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

function pullRequest(number: number, owner = "owner", repository = "repository"): PullRequestUrl {
  const parsed = parsePullRequestUrl(`https://github.com/${owner}/${repository}/pull/${number}`)
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

function githubWithStack(getStack: GitHubClient["getStack"]): GitHubClient {
  return {
    getStack,
    async get(pullRequests) {
      return { ok: true, value: pullRequests.map(availableGitHubItem) }
    },
  }
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
  test("attaches a complete stack in bottom-to-top order", async () => {
    const store = await temporaryStateStore()
    const stack = [pullRequest(1), pullRequest(2), pullRequest(3)] as const
    const github = githubWithStack(async () => ({ ok: true, value: stack }))

    expect(await attachPullRequest({ store, github }, "session", stack[1])).toEqual({
      ok: true,
      value: "added",
    })
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.number)).toEqual([1, 2, 3])
  })

  test("normalizes a partially attached stack without disturbing mixed-repository attachments", async () => {
    const store = await temporaryStateStore()
    const unrelatedBefore = pullRequest(91, "another", "project")
    const unrelatedAfter = pullRequest(92, "another", "project")
    for (const item of [unrelatedBefore, pullRequest(3), unrelatedAfter, pullRequest(1)]) {
      await store.attach("session", item)
    }
    const github = githubWithStack(async () => ({
      ok: true,
      value: [pullRequest(1), pullRequest(2), pullRequest(3)],
    }))

    expect(await attachPullRequest({ store, github }, "session", pullRequest(2))).toEqual({
      ok: true,
      value: "added",
    })
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.url)).toEqual([
      unrelatedBefore.url,
      pullRequest(1).url,
      pullRequest(2).url,
      pullRequest(3).url,
      unrelatedAfter.url,
    ])
  })

  test("returns a stack discovery failure without mutating state", async () => {
    const store = await temporaryStateStore()
    await store.attach("session", pullRequest(1))
    const requested = pullRequest(404)
    const github = githubWithStack(async () => ({
      ok: false,
      error: {
        tag: "PullRequestNotFound",
        message: "Pull request does not exist or is not accessible",
      },
    }))

    expect(await attachPullRequest({ store, github }, "session", requested)).toEqual({
      ok: false,
      error: {
        tag: "PullRequestNotFound",
        message: "Pull request does not exist or is not accessible",
      },
    })
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.number)).toEqual([1])
  })

  test("rejects a 21-member stack without mutating state", async () => {
    const store = await temporaryStateStore()
    const members = Array.from({ length: 21 }, (_, index) => pullRequest(index + 1))
    const first = members[0]
    if (first === undefined) throw new Error("expected a non-empty stack fixture")
    const stack = [first, ...members.slice(1)] as const
    const github = githubWithStack(async () => ({ ok: true, value: stack }))

    expect(await attachPullRequest({ store, github }, "session", pullRequest(11))).toEqual({
      ok: false,
      error: {
        tag: "AttachmentLimitReached",
        limit: 20,
        message: "A session can track at most 20 pull requests",
      },
    })
    expect(await store.list("session")).toEqual({ ok: true, value: [] })
  })

  test("propagates the caller signal to stack discovery", async () => {
    const store = await temporaryStateStore()
    const requested = pullRequest(1)
    let requestSignal: AbortSignal | undefined
    const github = githubWithStack(async (value, options) => {
      requestSignal = options?.signal
      return { ok: true, value: [value] }
    })
    const signal = new AbortController().signal

    expect(await attachPullRequest({ store, github }, "session", requested, { signal })).toEqual({
      ok: true,
      value: "added",
    })
    expect(requestSignal).toBe(signal)
  })

  test("serializes stack discovery and attachment in same-session FIFO order", async () => {
    const store = await temporaryStateStore()
    const firstDiscoveryStarted = deferred()
    const releaseFirstDiscovery = deferred()
    const discoveryStarts: number[] = []
    const discover = async (requested: PullRequestUrl) => {
      discoveryStarts.push(requested.number)
      if (requested.number === 1) {
        firstDiscoveryStarted.resolve()
        await releaseFirstDiscovery.promise
      }
    }
    const github: GitHubClient = {
      async getStack(requested) {
        await discover(requested)
        return { ok: true, value: [requested] }
      },
      async get(pullRequests) {
        const requested = pullRequests[0]
        if (requested === undefined) throw new Error("expected one pull request")
        await discover(requested)
        return { ok: true, value: [availableGitHubItem(requested)] }
      },
    }

    const first = attachPullRequest({ store, github }, "session", pullRequest(1))
    await firstDiscoveryStarted.promise
    const second = attachPullRequest({ store, github }, "session", pullRequest(2))
    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })
    await Promise.resolve()

    expect(discoveryStarts).toEqual([1])
    expect(secondSettled).toBe(false)
    releaseFirstDiscovery.resolve()

    expect(await Promise.all([first, second])).toEqual([
      { ok: true, value: "added" },
      { ok: true, value: "added" },
    ])
    expect(discoveryStarts).toEqual([1, 2])
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.number)).toEqual([1, 2])
  })

  test("repeated stack attachment does not duplicate members", async () => {
    const store = await temporaryStateStore()
    const stack = [pullRequest(1), pullRequest(2), pullRequest(3)] as const
    let discoveryCalls = 0
    const github = githubWithStack(async () => {
      discoveryCalls += 1
      return { ok: true, value: stack }
    })

    expect(await attachPullRequest({ store, github }, "session", stack[1])).toEqual({
      ok: true,
      value: "added",
    })
    expect(await attachPullRequest({ store, github }, "session", stack[1])).toEqual({
      ok: true,
      value: "already_attached",
    })
    expect(discoveryCalls).toBe(2)
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.number)).toEqual([1, 2, 3])
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
