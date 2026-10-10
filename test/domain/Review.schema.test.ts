import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import { Option, Schema } from "effect"

import { threadsOf, Threads } from "../../src/domain/Review.ts"
import { reviews } from "../support/generators.ts"
import { evidence } from "../support/reviewEvidence.ts"

const decode = Schema.decodeUnknownOption(Threads)

const valid = { complete: true, fetched: 5, replied: 2, unreplied: 3 }

describe("Threads schema", () => {
  test("decodes every count the server derives from GitHub's threads", () => {
    hegel.test((tc) => {
      const counted = threadsOf(tc.draw(evidence()))

      expect(decode(counted)).toEqual(Option.some(counted))
    })
  })

  test("decodes the review states a server can send", () => {
    hegel.test((tc) => {
      const { threads } = tc.draw(reviews)

      expect(decode(threads)).toEqual(Option.some(threads))
    })
  })

  test.each<readonly [string, Threads]>([
    ["a negative fetched count", { complete: true, fetched: -1, replied: 0, unreplied: 0 }],
    ["a negative replied count", { complete: true, fetched: 5, replied: -1, unreplied: 3 }],
    ["a negative unreplied count", { complete: true, fetched: 5, replied: 2, unreplied: -2 }],
    ["a fractional count", { complete: true, fetched: 5, replied: 1.5, unreplied: 0 }],
    [
      "more unresolved threads than fetched",
      { complete: false, fetched: 4, replied: 2, unreplied: 3 },
    ],
  ])("rejects %s", (_name, threads) => {
    expect(decode(valid)).toEqual(Option.some(valid))
    expect(decode(threads)).toEqual(Option.none())
  })
})
