import { Option, Result, Schema } from "effect"

const canonicalSegment = /^(?!\.{1,2}$)[a-z0-9._-]+$/u

const pullRequestUrl =
  /^(?:https:\/\/)?github\.com\/(?<owner>[\w.-]+)\/(?<repository>[\w.-]+)\/pull\/(?<number>\d+)$/iu

const decimal = /^\d+$/u

/** Printable ASCII only. With the `u` and `i` flags, `\w` also matches letters that fold to ASCII. */
const printableAscii = /^[\u0021-\u007E]*$/u

export const Segment = Schema.String.check(Schema.isPattern(canonicalSegment))

export const PullRequestNumber = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
)

/** A canonical github.com pull request. Owner and repository are lowercase. */
export class PullRequestRef extends Schema.Class<PullRequestRef>("PullRequestRef")({
  number: PullRequestNumber,
  owner: Segment,
  repository: Segment,
}) {
  public get url(): string {
    return `https://github.com/${this.owner}/${this.repository}/pull/${String(this.number)}`
  }

  public get label(): string {
    return `${this.owner}/${this.repository}#${String(this.number)}`
  }
}

export class InvalidPullRequestUrl extends Schema.TaggedError<InvalidPullRequestUrl>()(
  "InvalidPullRequestUrl",
  { input: Schema.String },
) {}

export class InvalidPullRequestInput extends Schema.TaggedError<InvalidPullRequestInput>()(
  "InvalidPullRequestInput",
  { input: Schema.String },
) {}

/** A pull request named by URL, or by number within a repository resolved later. */
export type PullRequestInput =
  | { readonly _tag: "Reference"; readonly ref: PullRequestRef }
  | { readonly _tag: "Number"; readonly number: number }

const decodeRef = Schema.decodeUnknownOption(PullRequestRef)

const decodeNumber = Schema.decodeUnknownOption(PullRequestNumber)

export function sameRepository(left: PullRequestRef, right: PullRequestRef): boolean {
  return left.owner === right.owner && left.repository === right.repository
}

export function samePullRequest(left: PullRequestRef, right: PullRequestRef): boolean {
  return left.url === right.url
}

export function parsePullRequestUrl(
  input: string,
): Result.Result<PullRequestRef, InvalidPullRequestUrl> {
  const match = printableAscii.test(input) ? pullRequestUrl.exec(input) : null
  const groups = match === null ? {} : (match.groups ?? {})

  const candidate = {
    number: Number(groups["number"] ?? Number.NaN),
    owner: (groups["owner"] ?? "").toLowerCase(),
    repository: (groups["repository"] ?? "").toLowerCase(),
  }

  return Result.fromOption(decodeRef(candidate), () => new InvalidPullRequestUrl({ input }))
}

export function parsePullRequestInput(
  input: string,
): Result.Result<PullRequestInput, InvalidPullRequestInput> {
  const reference = parsePullRequestUrl(input)

  if (Result.isSuccess(reference))
    return Result.succeed({ _tag: "Reference", ref: reference.success })

  const number = decimal.test(input) ? decodeNumber(Number(input)) : Option.none()

  return Result.fromOption(number, () => new InvalidPullRequestInput({ input })).pipe(
    Result.map((value) => ({ _tag: "Number", number: value })),
  )
}
