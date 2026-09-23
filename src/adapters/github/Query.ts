/** GraphQL documents for the batched pull request query and check-context continuation pages. */

export const defaultPageSize = 100

const contexts = (pageSize: number, after: string): string => `
  contexts(first: ${String(pageSize)}${after}) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on StatusContext { context state createdAt }
      ... on CheckRun {
        name status conclusion
        checkSuite {
          createdAt
          app { id }
          workflowRun { event runNumber runAttempt workflow { id } }
        }
      }
    }
  }`

const pullRequest = (pageSize: number): string => `
  __typename
  ... on PullRequest {
    url title state isDraft mergeable mergeStateStatus
    stack {
      id size
      entries(first: 100) {
        totalCount
        pageInfo { hasNextPage }
        nodes { position pullRequest { url } }
      }
    }
    statusCheckRollup { ${contexts(pageSize, "")} }
  }`

export const alias = (index: number): string => `pr${String(index)}`

/** One query for `count` pull requests, passed as variables `pr0`, `pr1`, and so on. */
export function batch(count: number, pageSize = defaultPageSize): string {
  const indexes = Array.from({ length: count }, (_, index) => index)
  const variables = indexes.map((index) => `$${alias(index)}: URI!`).join(", ")

  const fields = indexes
    .map((index) => `${alias(index)}: resource(url: $${alias(index)}) { ${pullRequest(pageSize)} }`)
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
