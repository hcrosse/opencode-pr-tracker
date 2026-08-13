declare const pullRequestUrlBrand: unique symbol
declare const pullRequestBrand: unique symbol

export type CanonicalPullRequestUrl = string & {
  readonly [pullRequestUrlBrand]: "CanonicalPullRequestUrl"
}

export type PullRequestUrl = Readonly<{
  url: CanonicalPullRequestUrl
  owner: string
  repository: string
  number: number
  readonly [pullRequestBrand]: "PullRequestUrl"
}>

export type NonEmptyPullRequests = readonly [PullRequestUrl, ...PullRequestUrl[]]

const expectedPullRequestUrl =
  "Expected https://github.com/<owner>/<repository>/pull/<positive-integer> or github.com/<owner>/<repository>/pull/<positive-integer>" as const

export type InvalidPullRequestUrl = Readonly<{
  tag: "InvalidPullRequestUrl"
  message: typeof expectedPullRequestUrl
}>

export type Result<Value, Failure> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: Failure }>

const invalidPullRequestUrl: Result<never, InvalidPullRequestUrl> = {
  ok: false,
  error: {
    tag: "InvalidPullRequestUrl",
    message: expectedPullRequestUrl,
  },
}

const segmentPattern = /^[A-Za-z0-9._-]+$/
const schemeLessPrefix = "github.com/"

export function parsePullRequestUrl(input: string): Result<PullRequestUrl, InvalidPullRequestUrl> {
  if (/\s/.test(input)) return invalidPullRequestUrl
  if (input.includes("\\")) return invalidPullRequestUrl

  const candidate =
    input.slice(0, schemeLessPrefix.length).toLowerCase() === schemeLessPrefix ? `https://${input}` : input
  if (!candidate.startsWith("https://")) return invalidPullRequestUrl

  const authorityEnd = candidate.indexOf("/", "https://".length)
  if (authorityEnd === -1) return invalidPullRequestUrl
  if (candidate.slice("https://".length, authorityEnd).toLowerCase() !== "github.com") {
    return invalidPullRequestUrl
  }

  const rawPath = candidate.slice(authorityEnd).split(/[?#]/, 1).join("")
  for (const segment of rawPath.split("/")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return invalidPullRequestUrl
    }
    if (decoded === "." || decoded === "..") return invalidPullRequestUrl
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return invalidPullRequestUrl
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return invalidPullRequestUrl
  }

  const segments = parsed.pathname.split("/")
  if (segments.length !== 5 || segments[0] !== "" || segments[3] !== "pull") {
    return invalidPullRequestUrl
  }

  const rawOwner = segments[1]
  const rawRepository = segments[2]
  const numberText = segments[4]
  if (
    rawOwner === undefined ||
    rawRepository === undefined ||
    numberText === undefined ||
    !segmentPattern.test(rawOwner) ||
    !segmentPattern.test(rawRepository) ||
    !/^\d+$/.test(numberText)
  ) {
    return invalidPullRequestUrl
  }

  const number = Number(numberText)
  if (!Number.isSafeInteger(number) || number <= 0) return invalidPullRequestUrl

  const owner = rawOwner.toLowerCase()
  const repository = rawRepository.toLowerCase()
  // SAFETY: every URL component passed the canonical GitHub PR checks above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the parser establishes the brand invariant
  const url = `https://github.com/${owner}/${repository}/pull/${number}` as CanonicalPullRequestUrl
  const value = { url, owner, repository, number }
  // SAFETY: the parser established canonical URL and component consistency.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parser establishes the object brand
  return { ok: true, value: value as PullRequestUrl }
}

export function formatPullRequestRef(pullRequest: PullRequestUrl): string {
  return `${pullRequest.owner}/${pullRequest.repository}#${pullRequest.number}`
}
