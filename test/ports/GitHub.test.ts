import { expect, test } from "vitest"

import { charged, ItemResult } from "../../src/ports/GitHub.ts"

test("only an unavailable GitHub fails at a charge", () => {
  const charges: readonly ItemResult[] = [
    charged,
    // @ts-expect-error A charged failure cannot be a missing pull request.
    ItemResult.Failed({ charged: true, diagnostic: "NotFound" }),
    // @ts-expect-error A charged failure cannot be a rate limit.
    ItemResult.Failed({ charged: true, diagnostic: "RateLimited" }),
  ]

  expect(charges).toContainEqual(charged)
})
