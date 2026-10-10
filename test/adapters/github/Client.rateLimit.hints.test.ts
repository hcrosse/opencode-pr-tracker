import { describe, expect, test } from "bun:test"

import { Exit } from "effect"

import { httpClient, requestsAt, runClient, type RequestBody } from "../../support/github.ts"

const minute = 60_000

const hour = 3_600_000

/** A first response from GitHub, then answers to everything after it. */
const firstThenAnswered =
  (first: () => Response) =>
  (_body: RequestBody, count: number): Response =>
    count === 1 ? first() : Response.json({ data: { pr0: null } })

describe("GitHub client rate-limit hints", () => {
  test.each([
    ["an empty retry-after", { "retry-after": "" }, minute],
    ["an HTTP-date retry-after", { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, minute],
    ["a negative retry-after", { "retry-after": "-5" }, minute],
    ["a decimal retry-after", { "retry-after": "1.5" }, minute],
    ["a spent budget without a reset time", { "x-ratelimit-remaining": "0" }, minute],
    [
      "a spent budget with a decimal reset time",
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "30.5" },
      minute,
    ],
    [
      "a spent budget with a reset time",
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "30" },
      30_000,
    ],
    ["a retry-after in seconds", { "retry-after": "90" }, 90_000],
    ["a retry-after over an hour", { "retry-after": "86400" }, hour],
    ["a huge retry-after", { "retry-after": "99999999999999999999999" }, hour],
  ] as const)("on a 403 with %s, waits as long as expected", async (_name, headers, wait) => {
    const http = httpClient(firstThenAnswered(() => new Response("", { headers, status: 403 })))

    const result = await runClient({ http }, requestsAt(http, [0, wait - 1, wait]))

    expect(result).toEqual(Exit.succeed([1, 1, 2]))
  })
})
