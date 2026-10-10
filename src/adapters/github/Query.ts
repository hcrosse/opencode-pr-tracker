/** GraphQL documents for the batched pull request query and check-context continuation pages. */
import type { PullRequestRef } from "../../domain/PullRequest.ts"
import type { ReviewMode } from "../../domain/Review.ts"
import type { Variables } from "./Post.ts"

export const defaultPageSize = 100

/** Review threads fetched per pull request; when there are more, counts are lower bounds. */
const reviewPageSize = 20

/** The review fields each review mode asks for. */
const reviewSelections: Readonly<Record<ReviewMode, string>> = {
  all: `
    headRefOid author { login } reviewDecision
    latestOpinionatedReviews(first: 100, writersOnly: true) {
      pageInfo { hasNextPage }
      nodes { state commit { oid } }
    }
    reviewThreads(first: ${String(reviewPageSize)}) {
      pageInfo { hasNextPage }
      nodes { isResolved comments(last: 5) { nodes { state author { login } } } }
    }`,
  off: "",
}

const contexts = (pageSize: number, after: string): string => `
  contexts(first: ${String(pageSize)}${after}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on StatusContext { context state createdAt }
      ... on CheckRun {
        name status conclusion
        checkSuite {
          id
          createdAt
          app { id }
          workflowRun { event runNumber runAttempt workflow { id } }
        }
      }
    }
  }`

const pullRequest = (reviews: ReviewMode, pageSize: number): string => `
  title state isDraft mergeable mergeStateStatus${reviewSelections[reviews]}
  stack {
    id size
    entries(first: 100) {
      pageInfo { hasNextPage }
      nodes { position pullRequest { url state } }
    }
  }
  statusCheckRollup { ${contexts(pageSize, "")} }`

export const alias = (index: number): string => `pr${String(index)}`

/**
 * Looks a pull request up by owner, name and number, which GitHub matches in any case;
 * `resource(url:)` finds a repository named with capitals only by its exact URL.
 */
const lookup = (prefix: string, selection: string): string =>
  `repository(owner: $${prefix}owner, name: $${prefix}name) { pullRequest(number: $${prefix}number) { ${selection} } }`

const declared = (prefix: string): string =>
  `$${prefix}owner: String!, $${prefix}name: String!, $${prefix}number: Int!`

const lookupVariables = (prefix: string, ref: PullRequestRef): [string, string | number][] => [
  [`${prefix}owner`, ref.owner],
  [`${prefix}name`, ref.repository],
  [`${prefix}number`, ref.number],
]

/** The largest GraphQL `Int`, which is signed 32-bit. */
const largestInt = 2_147_483_647

/**
 * Whether GitHub can be asked for `ref`. A larger number fails the coercion of every variable, and
 * with it the whole batch, so no such pull request can exist.
 */
export const queryable = (ref: PullRequestRef): boolean => ref.number <= largestInt

/** The variable-name prefix for the pull request at `index` of a batch, as in `pr0_owner`. */
const batchPrefix = (index: number): string => `${alias(index)}_`

/** One query for `count` pull requests, each answered under its alias `pr0`, `pr1`, and so on. */
export function batch(count: number, reviews: ReviewMode, pageSize = defaultPageSize): string {
  const prefixes = Array.from({ length: count }, (_, index) => batchPrefix(index))
  const variables = prefixes.map((prefix) => declared(prefix)).join(", ")

  const fields = prefixes
    .map((prefix, index) => `${alias(index)}: ${lookup(prefix, pullRequest(reviews, pageSize))}`)
    .join("\n")

  return `query PullRequests(${variables}) {\n${fields}\n}`
}

/** The variables `batch` takes for `refs`, in order. */
export const batchVariables = (refs: readonly PullRequestRef[]): Variables =>
  Object.fromEntries(refs.flatMap((ref, index) => lookupVariables(batchPrefix(index), ref)))

/** The next page of check contexts for one pull request, answered under `repository`. */
export function continuation(pageSize = defaultPageSize): string {
  const selection = `statusCheckRollup { ${contexts(pageSize, ", after: $cursor")} }`

  return `query CheckContexts(${declared("")}, $cursor: String!) {
  ${lookup("", selection)}
}`
}

/** The variables `continuation` takes for the page of `ref`'s check contexts after `cursor`. */
export const continuationVariables = (ref: PullRequestRef, cursor: string): Variables =>
  Object.fromEntries([...lookupVariables("", ref), ["cursor", cursor]])
