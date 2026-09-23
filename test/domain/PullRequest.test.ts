import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Result } from "effect"

import {
  parsePullRequestInput,
  parsePullRequestUrl,
  samePullRequest,
} from "../../src/domain/PullRequest.ts"
import { pullRequestRefs, spellings, urlParts, type UrlParts } from "../support/generators.ts"

const path = (parts: UrlParts): string =>
  `${parts.owner}/${parts.repository}/pull/${String(parts.number)}`

/** Ways to turn a valid URL into one the parser must reject. */
const invalidSpellings: readonly (readonly [string, (parts: UrlParts) => string])[] = [
  ["leading whitespace", (parts) => ` https://github.com/${path(parts)}`],
  ["trailing newline", (parts) => `https://github.com/${path(parts)}\n`],
  ["backslash", (parts) => `https://github.com\\${path(parts)}`],
  ["query", (parts) => `https://github.com/${path(parts)}?tab=files`],
  ["fragment", (parts) => `https://github.com/${path(parts)}#top`],
  ["trailing slash", (parts) => `https://github.com/${path(parts)}/`],
  ["extra segment", (parts) => `https://github.com/${path(parts)}/files`],
  ["other host", (parts) => `https://gitlab.com/${path(parts)}`],
  ["subdomain", (parts) => `https://www.github.com/${path(parts)}`],
  ["port", (parts) => `https://github.com:443/${path(parts)}`],
  ["credentials", (parts) => `https://user@github.com/${path(parts)}`],
  ["http scheme", (parts) => `http://github.com/${path(parts)}`],
  ["issue path", (parts) => `https://github.com/${parts.owner}/${parts.repository}/issues/1`],
  ["zero number", (parts) => `https://github.com/${parts.owner}/${parts.repository}/pull/0`],
  [
    "unsafe number",
    (parts) => `https://github.com/${parts.owner}/${parts.repository}/pull/9007199254740993`,
  ],
  ["dot owner", (parts) => `https://github.com/./${parts.repository}/pull/1`],
  ["dot-dot repository", (parts) => `https://github.com/${parts.owner}/../pull/1`],
  ["encoded dot", (parts) => `https://github.com/%2e/${parts.repository}/pull/1`],
  ["missing repository", (parts) => `https://github.com/${parts.owner}/pull/1`],
]

const invalidUrls = gs.composite((tc) => {
  const [name, spell] = tc.draw(gs.sampledFrom(invalidSpellings))
  const url = spell(tc.draw(urlParts))

  tc.note(`${name}: ${JSON.stringify(url)}`)

  return url
})

describe("parsePullRequestUrl accepts", () => {
  test("accepts every valid spelling and canonicalizes it", () => {
    hegel.test((tc) => {
      const parts = tc.draw(urlParts)
      const ref = Result.getOrThrow(parsePullRequestUrl(tc.draw(spellings(parts))))

      expect([ref.owner, ref.repository, ref.number]).toEqual([
        parts.owner.toLowerCase(),
        parts.repository.toLowerCase(),
        parts.number,
      ])
    })
  })

  test("parses its own canonical URL back to the same reference", () => {
    hegel.test((tc) => {
      const ref = tc.draw(pullRequestRefs)
      const reparsed = Result.getOrThrow(parsePullRequestUrl(ref.url))

      expect(reparsed).toEqual(ref)
      expect(reparsed.url).toBe(ref.url)
    })
  })
})

describe("pull request identity", () => {
  test("treats spellings that differ only in case as one pull request", () => {
    hegel.test((tc) => {
      const parts = tc.draw(urlParts)

      const upper = {
        number: parts.number,
        owner: parts.owner.toUpperCase(),
        repository: parts.repository.toUpperCase(),
      }

      const left = Result.getOrThrow(parsePullRequestUrl(`github.com/${path(parts)}`))
      const right = Result.getOrThrow(parsePullRequestUrl(`https://github.com/${path(upper)}`))

      expect(samePullRequest(left, right)).toBe(true)
    })
  })
})

describe("parsePullRequestUrl rejects and formats", () => {
  test("rejects near-miss URLs", () => {
    hegel.test((tc) => {
      expect(Result.isFailure(parsePullRequestUrl(tc.draw(invalidUrls)))).toBe(true)
    })
  })

  test("formats a canonical URL and label", () => {
    const ref = Result.getOrThrow(
      parsePullRequestUrl("https://GITHUB.COM/OpenCode-AI/OpenCode/pull/00042"),
    )

    expect(ref.url).toBe("https://github.com/opencode-ai/opencode/pull/42")
    expect(ref.label).toBe("opencode-ai/opencode#42")
  })
})

describe("parsePullRequestInput", () => {
  test("reads a positive decimal number as a number in the current repository", () => {
    hegel.test((tc) => {
      const number = tc.draw(gs.integers({ maxValue: Number.MAX_SAFE_INTEGER, minValue: 1 }))

      expect(Result.getOrThrow(parsePullRequestInput(String(number)))).toEqual({
        _tag: "Number",
        number,
      })
    })
  })

  test("reads a valid URL as a reference", () => {
    hegel.test((tc) => {
      const ref = tc.draw(pullRequestRefs)
      const input = Result.getOrThrow(parsePullRequestInput(ref.url))

      expect(input._tag === "Reference" && samePullRequest(input.ref, ref)).toBe(true)
    })
  })

  test("rejects near-miss URLs and non-numbers", () => {
    hegel.test((tc) => {
      const input = tc.draw(
        gs.oneOf(
          invalidUrls,
          gs.sampledFrom(["", "0", "-1", "+1", "1.0", " 1", "1e3", "9007199254740993"]),
        ),
      )

      expect(Result.isFailure(parsePullRequestInput(input))).toBe(true)
    })
  })
})
