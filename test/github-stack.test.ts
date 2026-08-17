import { describe, expect, test } from "bun:test"

import { createGitHubClient, type ProcessRunner } from "../src/github.js"
import { parsePullRequestUrl } from "../src/url.js"
import {
  fieldValue,
  invalidItem,
  processExecutionFailed,
  pullRequest,
  runnerFor,
  secondPullRequest,
} from "./github-fixtures.js"

const firstStackParsed = parsePullRequestUrl("https://github.com/owner/repository/pull/41")
if (!firstStackParsed.ok) throw new Error("first stack fixture URL is invalid")
const firstStackPullRequest = firstStackParsed.value
const thirdStackParsed = parsePullRequestUrl("https://github.com/owner/repository/pull/43")
if (!thirdStackParsed.ok) throw new Error("third stack fixture URL is invalid")
const thirdStackPullRequest = thirdStackParsed.value

function runnerForSequence(
  outputs: readonly unknown[],
  calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = [],
): ProcessRunner {
  let index = 0
  return async (file, args, options) => {
    calls.push({ file, args, ...(options.signal ? { signal: options.signal } : {}) })
    const output = outputs[index]
    index += 1
    if (output === undefined) throw new Error("unexpected runner call")
    return { stdout: JSON.stringify(output) }
  }
}

function stackEntry(position: unknown, url: unknown): Record<string, unknown> {
  return { position, pullRequest: { url } }
}

function pullRequestAt(number: number, owner = "owner", repository = "repository") {
  const parsed = parsePullRequestUrl(`https://github.com/${owner}/${repository}/pull/${number}`)
  if (!parsed.ok) throw new Error("stack fixture URL is invalid")
  return parsed.value
}

function stackValue(
  id: unknown,
  size: unknown,
  nodes: readonly unknown[],
  pageInfo: Readonly<{ hasNextPage: unknown; endCursor: unknown }> = { hasNextPage: false, endCursor: null },
  totalCount: unknown = size,
): Record<string, unknown> {
  return { id, size, entries: { nodes, totalCount, pageInfo } }
}

function stackResource(url: string, value: unknown): Record<string, unknown> {
  return { __typename: "PullRequest", url, stack: value }
}

function stackBatchResponse(resources: readonly unknown[], errors?: readonly unknown[]): Record<string, unknown> {
  return {
    data: Object.fromEntries(resources.map((resource, index) => [`pr${index}`, resource])),
    ...(errors === undefined ? {} : { errors }),
  }
}

function stack(
  overrides: Record<string, unknown> = {},
  entriesOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "stack-1",
    size: 3,
    entries: {
      nodes: [
        stackEntry(3, thirdStackPullRequest.url),
        stackEntry(1, firstStackPullRequest.url),
        stackEntry(2, pullRequest.url),
      ],
      totalCount: 3,
      pageInfo: { hasNextPage: false, endCursor: "cursor-3" },
      ...entriesOverrides,
    },
    ...overrides,
  }
}

function stackResponse(stackData: unknown, resourceOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const resource = {
    __typename: "PullRequest",
    url: pullRequest.url,
    stack: stackData,
    ...resourceOverrides,
  }
  return {
    data: {
      pr0: resource,
      resource,
    },
  }
}

function stackPage(
  nodes: readonly unknown[],
  input: Readonly<{
    id?: unknown
    size?: unknown
    totalCount?: unknown
    hasNextPage?: unknown
    endCursor?: unknown
  }> = {},
): Record<string, unknown> {
  return stackResponse(
    stack(
      { id: input.id ?? "stack-1", size: input.size ?? 3 },
      {
        nodes,
        totalCount: input.totalCount ?? 3,
        pageInfo: {
          hasNextPage: input.hasNextPage ?? false,
          endCursor: "endCursor" in input ? input.endCursor : null,
        },
      },
    ),
  )
}

describe("GitHub client", () => {
  test("batch stack discovery aligns standalone and Stack memberships in one request", async () => {
    const calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = []
    const stackBase = firstStackPullRequest
    const stackHead = pullRequest
    const standalone = secondPullRequest
    const response = stackBatchResponse([
      stackResource(standalone.url, null),
      stackResource(
        stackHead.url,
        stackValue("stack-1", 2, [stackEntry(2, stackHead.url), stackEntry(1, stackBase.url)]),
      ),
    ])

    const result = await createGitHubClient(runnerFor(response, calls)).getStacks([standalone, stackHead])

    expect(result).toEqual({
      ok: true,
      value: [
        { ok: true, value: { tag: "Standalone", pullRequest: standalone } },
        { ok: true, value: { tag: "Stack", id: "stack-1", members: [stackBase, stackHead] } },
      ],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args[5]).toContain("pr0: resource(url: $url0)")
    expect(calls[0]?.args[5]).toContain("pr1: resource(url: $url1)")
    expect(calls[0]?.args.slice(6)).toEqual(["-f", `url0=${standalone.url}`, "-f", `url1=${stackHead.url}`])
  })

  test("batch stack discovery exhausts shared Stack pages once", async () => {
    const calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = []
    const stackBase = firstStackPullRequest
    const stackHead = thirdStackPullRequest
    const initialStack = stackValue("stack-1", 3, [stackEntry(1, stackBase.url)], {
      hasNextPage: true,
      endCursor: "stack-page-1",
    })
    const initial = stackBatchResponse([
      stackResource(pullRequest.url, initialStack),
      stackResource(stackHead.url, initialStack),
    ])
    const continuation = stackResponse(
      stackValue("stack-1", 3, [stackEntry(2, pullRequest.url), stackEntry(3, stackHead.url)]),
      { url: pullRequest.url },
    )

    const result = await createGitHubClient(runnerForSequence([initial, continuation], calls)).getStacks([
      pullRequest,
      stackHead,
    ])

    const membership = {
      tag: "Stack",
      id: "stack-1",
      members: [stackBase, pullRequest, stackHead],
    } as const
    expect(result).toEqual({
      ok: true,
      value: [
        { ok: true, value: membership },
        { ok: true, value: membership },
      ],
    })
    expect(calls).toHaveLength(2)
    expect(fieldValue(calls[1]?.args ?? [], "url")).toBe(pullRequest.url)
    expect(fieldValue(calls[1]?.args ?? [], "cursor")).toBe("stack-page-1")
  })

  test("batch stack discovery returns an empty batch without starting a process", async () => {
    let calls = 0
    const client = createGitHubClient(async () => {
      calls += 1
      return { stdout: "" }
    })

    expect(await client.getStacks([])).toEqual({ ok: true, value: [] })
    expect(calls).toBe(0)
  })

  test("batch stack discovery rejects more than 20 requested pull requests", async () => {
    let calls = 0
    const client = createGitHubClient(async () => {
      calls += 1
      return { stdout: "" }
    })
    const requested = Array.from({ length: 21 }, (_, index) => pullRequestAt(index + 1))

    expect(await client.getStacks(requested)).toEqual({
      ok: false,
      error: {
        tag: "GitHubBatchLimitExceeded",
        limit: 20,
        message: "GitHub batch cannot contain more than 20 pull requests",
      },
    })
    expect(calls).toBe(0)
  })

  test("batch stack discovery returns every member of a remote Stack larger than 20", async () => {
    const members = [
      pullRequestAt(100),
      ...Array.from({ length: 20 }, (_, index) => pullRequestAt(index + 101)),
    ] as const
    const requested = members[10]
    if (requested === undefined) throw new Error("expected a requested Stack member")
    const initial = stackBatchResponse([
      stackResource(
        requested.url,
        stackValue("stack-21", 21, [stackEntry(1, members[0]?.url)], {
          hasNextPage: true,
          endCursor: "stack-page-1",
        }),
      ),
    ])
    const continuation = stackResponse(
      stackValue(
        "stack-21",
        21,
        members.slice(1).map((member, index) => stackEntry(index + 2, member.url)),
      ),
      { url: requested.url },
    )

    const result = await createGitHubClient(runnerForSequence([initial, continuation])).getStacks([requested])

    expect(result).toEqual({
      ok: true,
      value: [{ ok: true, value: { tag: "Stack", id: "stack-21", members } }],
    })
  })

  test.each([
    {
      name: "duplicate Stack positions",
      nodes: [stackEntry(1, firstStackPullRequest.url), stackEntry(1, pullRequest.url)],
    },
    {
      name: "duplicate Stack URLs",
      nodes: [stackEntry(1, pullRequest.url), stackEntry(2, pullRequest.url)],
    },
    {
      name: "a Stack member from another repository",
      nodes: [stackEntry(1, pullRequest.url), stackEntry(2, secondPullRequest.url)],
    },
  ])("batch stack discovery rejects $name", async ({ nodes }) => {
    const response = stackBatchResponse([stackResource(pullRequest.url, stackValue("stack-1", 2, nodes))])

    expect(await createGitHubClient(runnerFor(response)).getStacks([pullRequest])).toEqual({
      ok: true,
      value: [invalidItem],
    })
  })

  test.each([
    { name: "Stack ID", continuationId: "stack-2", continuationSize: 3, continuationCount: 3 },
    { name: "Stack size", continuationId: "stack-1", continuationSize: 4, continuationCount: 4 },
  ])(
    "batch stack discovery rejects a changed $name during continuation",
    async ({ continuationId, continuationSize, continuationCount }) => {
      const initial = stackBatchResponse([
        stackResource(
          pullRequest.url,
          stackValue("stack-1", 3, [stackEntry(2, pullRequest.url)], {
            hasNextPage: true,
            endCursor: "stack-page-1",
          }),
        ),
      ])
      const continuation = stackResponse(
        stackValue(
          continuationId,
          continuationSize,
          [stackEntry(1, firstStackPullRequest.url), stackEntry(3, thirdStackPullRequest.url)],
          undefined,
          continuationCount,
        ),
      )

      expect(await createGitHubClient(runnerForSequence([initial, continuation])).getStacks([pullRequest])).toEqual({
        ok: true,
        value: [invalidItem],
      })
    },
  )

  test("batch stack discovery propagates cancellation from a shared continuation", async () => {
    const controller = new AbortController()
    const continuationStarted = Promise.withResolvers<void>()
    const cause = new Error("aborted")
    let calls = 0
    const client = createGitHubClient((_file, _args, options) => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({
          stdout: JSON.stringify(
            stackBatchResponse([
              stackResource(
                pullRequest.url,
                stackValue("stack-1", 3, [stackEntry(2, pullRequest.url)], {
                  hasNextPage: true,
                  endCursor: "stack-page-1",
                }),
              ),
            ]),
          ),
        })
      }
      continuationStarted.resolve()
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(cause), { once: true })
      })
    })

    const request = client.getStacks([pullRequest], { signal: controller.signal })
    await continuationStarted.promise
    controller.abort()

    expect(await request).toEqual({
      ok: false,
      error: { tag: "GitHubCancelled", message: "GitHub status request cancelled", cause },
    })
  })

  test("batch stack discovery preserves a valid alias beside an invalid alias", async () => {
    const response = stackBatchResponse(
      [null, stackResource(secondPullRequest.url, null)],
      [{ message: "Resource could not be resolved", path: ["pr0"] }],
    )

    expect(await createGitHubClient(runnerFor(response)).getStacks([pullRequest, secondPullRequest])).toEqual({
      ok: true,
      value: [invalidItem, { ok: true, value: { tag: "Standalone", pullRequest: secondPullRequest } }],
    })
  })

  test("batch stack discovery rejects inconsistent initial pages for one Stack", async () => {
    const response = stackBatchResponse([
      stackResource(
        pullRequest.url,
        stackValue("stack-1", 3, [stackEntry(1, firstStackPullRequest.url)], {
          hasNextPage: true,
          endCursor: "stack-page-1",
        }),
      ),
      stackResource(
        thirdStackPullRequest.url,
        stackValue("stack-1", 3, [stackEntry(2, pullRequest.url)], {
          hasNextPage: true,
          endCursor: "stack-page-2",
        }),
      ),
    ])

    expect(await createGitHubClient(runnerFor(response)).getStacks([pullRequest, thirdStackPullRequest])).toEqual({
      ok: true,
      value: [invalidItem, invalidItem],
    })
  })

  test("stack facade preserves its async method contract", () => {
    const client = createGitHubClient()

    expect(client.getStack.length).toBe(1)
    expect(Object.getPrototypeOf(client.getStack)).toBe(Object.getPrototypeOf(async function () {}))
  })

  test("stack discovery returns the requested pull request when it has no stack", async () => {
    const calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = []
    const controller = new AbortController()
    const result = await createGitHubClient(runnerFor(stackResponse(null), calls)).getStack(pullRequest, {
      signal: controller.signal,
    })

    expect(result).toEqual({ ok: true, value: [pullRequest] })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ file: "gh", signal: controller.signal })
  })

  test("stack discovery returns stack pull requests in position order", async () => {
    const calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = []
    const result = await createGitHubClient(runnerFor(stackResponse(stack()), calls)).getStack(pullRequest)

    expect(result).toEqual({ ok: true, value: [firstStackPullRequest, pullRequest, thirdStackPullRequest] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args.slice(0, 5)).toEqual(["api", "graphql", "--method", "POST", "-f"])
    expect(calls[0]?.args[5]).toContain("stack { id size entries(first: 100)")
    expect(calls[0]?.args[5]).toContain("nodes { position pullRequest { url } }")
    expect(calls[0]?.args[5]).toContain("totalCount pageInfo { hasNextPage endCursor }")
    expect(calls[0]?.args.slice(6)).toEqual(["-f", `url0=${pullRequest.url}`])
  })

  test("stack discovery continues entry pages and propagates the caller signal", async () => {
    const calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = []
    const initial = stackPage([stackEntry(1, firstStackPullRequest.url)], {
      hasNextPage: true,
      endCursor: "stack-page-1",
    })
    const continuation = stackPage([stackEntry(3, thirdStackPullRequest.url), stackEntry(2, pullRequest.url)])
    const controller = new AbortController()

    const result = await createGitHubClient(runnerForSequence([initial, continuation], calls)).getStack(pullRequest, {
      signal: controller.signal,
    })

    expect(result).toEqual({ ok: true, value: [firstStackPullRequest, pullRequest, thirdStackPullRequest] })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.args[5]).toContain("query PullRequestStackEntries($url: URI!, $cursor: String!)")
    expect(calls[1]?.args[5]).toContain("entries(first: 100, after: $cursor)")
    expect(fieldValue(calls[1]?.args ?? [], "url")).toBe(pullRequest.url)
    expect(fieldValue(calls[1]?.args ?? [], "cursor")).toBe("stack-page-1")
    expect(calls.map((call) => call.signal)).toEqual([controller.signal, controller.signal])
  })

  test.each([
    {
      name: "a changed stack ID",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([stackEntry(1, firstStackPullRequest.url), stackEntry(3, thirdStackPullRequest.url)], {
        id: "stack-2",
      }),
    },
    {
      name: "a changed stack size",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([stackEntry(1, firstStackPullRequest.url), stackEntry(3, thirdStackPullRequest.url)], {
        size: 4,
        totalCount: 4,
      }),
    },
    {
      name: "a changed total count",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([stackEntry(1, firstStackPullRequest.url), stackEntry(3, thirdStackPullRequest.url)], {
        totalCount: 4,
      }),
    },
    {
      name: "a duplicate position",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([
        stackEntry(1, firstStackPullRequest.url),
        stackEntry(2, "https://github.com/owner/repository/pull/44"),
      ]),
    },
    {
      name: "a duplicate URL",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([stackEntry(1, firstStackPullRequest.url), stackEntry(3, pullRequest.url)]),
    },
    {
      name: "a position outside the stack size",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([stackEntry(1, firstStackPullRequest.url), stackEntry(4, thirdStackPullRequest.url)]),
    },
    {
      name: "a member from another repository",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([stackEntry(1, firstStackPullRequest.url), stackEntry(3, secondPullRequest.url)]),
    },
    {
      name: "a missing requested pull request",
      initial: stackPage([stackEntry(1, firstStackPullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([
        stackEntry(2, "https://github.com/owner/repository/pull/44"),
        stackEntry(3, thirdStackPullRequest.url),
      ]),
    },
    {
      name: "a blank continuing cursor",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([stackEntry(1, firstStackPullRequest.url)], {
        hasNextPage: true,
        endCursor: " ",
      }),
    },
    {
      name: "a repeated cursor",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([stackEntry(1, firstStackPullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
    },
    {
      name: "an empty continuing page",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([], { hasNextPage: true, endCursor: "stack-page-2" }),
    },
    {
      name: "an incomplete final entry count",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([stackEntry(1, firstStackPullRequest.url)]),
    },
    {
      name: "more than 100 nodes",
      initial: stackPage([stackEntry(1, pullRequest.url)], {
        size: 102,
        totalCount: 102,
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage(
        Array.from({ length: 101 }, (_, index) =>
          stackEntry(index + 2, `https://github.com/owner/repository/pull/${index + 100}`),
        ),
        { size: 102, totalCount: 102 },
      ),
    },
    {
      name: "more accumulated entries than the stack size",
      initial: stackPage([stackEntry(2, pullRequest.url)], {
        hasNextPage: true,
        endCursor: "stack-page-1",
      }),
      continuation: stackPage([
        stackEntry(1, firstStackPullRequest.url),
        stackEntry(2, "https://github.com/owner/repository/pull/44"),
        stackEntry(3, thirdStackPullRequest.url),
      ]),
    },
  ])("stack discovery rejects continuation with $name", async ({ initial, continuation }) => {
    const result = await createGitHubClient(runnerForSequence([initial, continuation])).getStack(pullRequest)

    expect(result).toEqual(invalidItem)
  })

  test("stack discovery returns GitHubCancelled when continuation is aborted", async () => {
    const controller = new AbortController()
    const continuationStarted = Promise.withResolvers<void>()
    const cause = new Error("aborted")
    let calls = 0
    const client = createGitHubClient((_file, _args, options) => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({
          stdout: JSON.stringify(
            stackPage([stackEntry(2, pullRequest.url)], {
              hasNextPage: true,
              endCursor: "stack-page-1",
            }),
          ),
        })
      }
      continuationStarted.resolve()
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(cause), { once: true })
      })
    })

    const request = client.getStack(pullRequest, { signal: controller.signal })
    await continuationStarted.promise
    controller.abort()

    expect(await request).toEqual({
      ok: false,
      error: {
        tag: "GitHubCancelled",
        message: "GitHub status request cancelled",
        cause,
      },
    })
  })

  test.each([
    {
      name: "authentication failure",
      failure: processExecutionFailed(4, "", "credential=secret-value"),
      tag: "GitHubAuthenticationRequired",
      message: "GitHub CLI authentication required",
    },
    {
      name: "process failure",
      failure: processExecutionFailed(1, "", "credential=secret-value"),
      tag: "GitHubUnavailable",
      message: "GitHub status unavailable",
    },
  ])("stack discovery preserves $name during continuation", async ({ failure, tag, message }) => {
    let calls = 0
    const client = createGitHubClient(async () => {
      calls += 1
      if (calls === 1) {
        return {
          stdout: JSON.stringify(
            stackPage([stackEntry(2, pullRequest.url)], {
              hasNextPage: true,
              endCursor: "stack-page-1",
            }),
          ),
        }
      }
      throw failure
    })

    const result = await client.getStack(pullRequest)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.tag).toBe(tag)
    expect(result.error.message).toBe(message)
    expect(result.error.tag).not.toContain("secret-value")
    expect(result.error.message).not.toContain("secret-value")
  })

  test("stack discovery returns PullRequestNotFound for a null resource", async () => {
    const result = await createGitHubClient(runnerFor({ data: { pr0: null } })).getStack(pullRequest)

    expect(result).toEqual({
      ok: false,
      error: {
        tag: "PullRequestNotFound",
        message: "Pull request does not exist or is not accessible",
      },
    })
  })

  test.each([
    { name: "a mismatched requested URL", response: stackResponse(stack(), { url: secondPullRequest.url }) },
    { name: "a blank stack ID", response: stackResponse(stack({ id: " " })) },
    { name: "a zero stack size", response: stackResponse(stack({ size: 0 })) },
    { name: "a fractional stack size", response: stackResponse(stack({ size: 3.5 })) },
    { name: "an unsafe stack size", response: stackResponse(stack({ size: Number.MAX_SAFE_INTEGER + 1 })) },
    { name: "a mismatched entry count", response: stackResponse(stack({}, { totalCount: 2 })) },
    { name: "missing page metadata", response: stackResponse(stack({}, { pageInfo: null })) },
    {
      name: "a non-boolean next-page marker",
      response: stackResponse(stack({}, { pageInfo: { hasNextPage: "false", endCursor: null } })),
    },
    {
      name: "a non-string page cursor",
      response: stackResponse(stack({}, { pageInfo: { hasNextPage: false, endCursor: 3 } })),
    },
    {
      name: "a missing continuation cursor",
      response: stackResponse(stack({}, { pageInfo: { hasNextPage: true, endCursor: null } })),
    },
    {
      name: "a next-page marker on a complete page",
      response: stackResponse(stack({}, { pageInfo: { hasNextPage: true, endCursor: "cursor-3" } })),
    },
    {
      name: "a zero entry position",
      response: stackResponse(
        stack(
          {},
          {
            nodes: [
              stackEntry(0, firstStackPullRequest.url),
              stackEntry(2, pullRequest.url),
              stackEntry(3, thirdStackPullRequest.url),
            ],
          },
        ),
      ),
    },
    {
      name: "a duplicate entry position",
      response: stackResponse(
        stack(
          {},
          {
            nodes: [
              stackEntry(1, firstStackPullRequest.url),
              stackEntry(1, pullRequest.url),
              stackEntry(3, thirdStackPullRequest.url),
            ],
          },
        ),
      ),
    },
    {
      name: "a duplicate pull request URL",
      response: stackResponse(
        stack(
          {},
          {
            nodes: [
              stackEntry(1, firstStackPullRequest.url),
              stackEntry(2, pullRequest.url),
              stackEntry(3, pullRequest.url),
            ],
          },
        ),
      ),
    },
    {
      name: "a pull request from another repository",
      response: stackResponse(
        stack(
          {},
          {
            nodes: [
              stackEntry(1, firstStackPullRequest.url),
              stackEntry(2, pullRequest.url),
              stackEntry(3, secondPullRequest.url),
            ],
          },
        ),
      ),
    },
    {
      name: "a stack without the requested pull request",
      response: stackResponse(
        stack(
          {},
          {
            nodes: [
              stackEntry(1, firstStackPullRequest.url),
              stackEntry(2, thirdStackPullRequest.url),
              stackEntry(3, "https://github.com/owner/repository/pull/44"),
            ],
          },
        ),
      ),
    },
    {
      name: "an invalid pull request URL",
      response: stackResponse(
        stack(
          {},
          {
            nodes: [
              stackEntry(1, firstStackPullRequest.url),
              stackEntry(2, pullRequest.url),
              stackEntry(3, "https://example.com/owner/repository/pull/43"),
            ],
          },
        ),
      ),
    },
  ])("stack discovery rejects $name", async ({ response: output }) => {
    const result = await createGitHubClient(runnerFor(output)).getStack(pullRequest)

    expect(result).toEqual(invalidItem)
  })
})
