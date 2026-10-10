/** GraphQL documents for the batched pull request query and check-context continuation pages. */
import type { ReviewMode } from "../../domain/Review.ts"

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
  __typename
  ... on PullRequest {
    url title state isDraft mergeable mergeStateStatus${reviewSelections[reviews]}
    stack {
      id size
      entries(first: 100) {
        pageInfo { hasNextPage }
        nodes { position pullRequest { url state } }
      }
    }
    statusCheckRollup { ${contexts(pageSize, "")} }
  }`

export const alias = (index: number): string => `pr${String(index)}`

/** One query for `count` pull requests, passed as variables `pr0`, `pr1`, and so on. */
export function batch(count: number, reviews: ReviewMode, pageSize = defaultPageSize): string {
  const indexes = Array.from({ length: count }, (_, index) => index)
  const variables = indexes.map((index) => `$${alias(index)}: URI!`).join(", ")

  const fields = indexes
    .map(
      (index) =>
        `${alias(index)}: resource(url: $${alias(index)}) { ${pullRequest(reviews, pageSize)} }`,
    )
    .join("\n")

  return `query PullRequests(${variables}) {\n${fields}\n}`
}

/** The next page of check contexts for one pull request, with variables `url` and `cursor`. */
export function continuation(pageSize = defaultPageSize): string {
  return `query CheckContexts($url: URI!, $cursor: String!) {
  resource(url: $url) {
    __typename
    ... on PullRequest { statusCheckRollup { ${contexts(pageSize, ", after: $cursor")} } }
  }
}`
}
