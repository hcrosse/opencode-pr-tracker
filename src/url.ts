declare const pullRequestUrlBrand: unique symbol

export type CanonicalPullRequestUrl = string & {
  readonly [pullRequestUrlBrand]: "CanonicalPullRequestUrl"
}

export type PullRequestUrl = Readonly<{
  url: CanonicalPullRequestUrl
  owner: string
  repository: string
  number: number
}>

export type InvalidPullRequestUrl = Readonly<{
  tag: "InvalidPullRequestUrl"
  message: "Expected https://github.com/<owner>/<repository>/pull/<positive-integer>"
}>

export type Result<Value, Failure> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: Failure }>

const invalidPullRequestUrl: Result<never, InvalidPullRequestUrl> = {
  ok: false,
  error: {
    tag: "InvalidPullRequestUrl",
    message: "Expected https://github.com/<owner>/<repository>/pull/<positive-integer>",
  },
}

const segmentPattern = /^[A-Za-z0-9._-]+$/

export function parsePullRequestUrl(input: string): Result<PullRequestUrl, InvalidPullRequestUrl> {
  if (input.trim() !== input) return invalidPullRequestUrl
  if (!input.startsWith("https://")) return invalidPullRequestUrl

  const authorityEnd = input.indexOf("/", "https://".length)
  if (authorityEnd === -1) return invalidPullRequestUrl
  if (input.slice("https://".length, authorityEnd).toLowerCase() !== "github.com") {
    return invalidPullRequestUrl
  }

  const rawPath = input.slice(authorityEnd).split(/[?#]/, 1)[0]
  for (const segment of rawPath?.split("/") ?? []) {
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
    parsed = new URL(input)
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

  const owner = segments[1]
  const repository = segments[2]
  const numberText = segments[4]
  if (
    owner === undefined ||
    repository === undefined ||
    numberText === undefined ||
    !segmentPattern.test(owner) ||
    !segmentPattern.test(repository) ||
    !/^\d+$/.test(numberText)
  ) {
    return invalidPullRequestUrl
  }

  const number = Number(numberText)
  if (!Number.isSafeInteger(number) || number <= 0) return invalidPullRequestUrl

  // SAFETY: every URL component passed the canonical GitHub PR checks above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the parser establishes the brand invariant
  const url = `https://github.com/${owner}/${repository}/pull/${number}` as CanonicalPullRequestUrl
  return {
    ok: true,
    value: { url, owner, repository, number },
  }
}

export function formatPullRequestRef(pullRequest: PullRequestUrl): string {
  return `${pullRequest.owner}/${pullRequest.repository}#${pullRequest.number}`
}
