import { expect, test } from "bun:test"

import { charged, type ItemResult } from "../../src/ports/GitHub.ts"

test("only an unavailable GitHub fails at a charge", () => {
  const charges: readonly ItemResult[] = [
    charged,
    // @ts-expect-error A charged failure cannot be a missing pull request.
    { _tag: "Failed", charged: true, diagnostic: "NotFound" },
    // @ts-expect-error A charged failure cannot be a rate limit.
    { _tag: "Failed", charged: true, diagnostic: "RateLimited" },
  ]

  expect(charges).toContainEqual({ _tag: "Failed", charged: true, diagnostic: "GitHubUnavailable" })
})
