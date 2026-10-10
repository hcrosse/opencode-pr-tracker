/** The next page of check contexts in a GitHub response, as the fixture recorder follows them. */
import { Effect, Option, Schema } from "effect"

const PageInfo = Schema.Struct({
  endCursor: Schema.NullOr(Schema.String),
  hasNextPage: Schema.Boolean,
})

const ContextPages = Schema.Struct({
  data: Schema.Record(
    Schema.String,
    Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            statusCheckRollup: Schema.NullOr(
              Schema.Struct({ contexts: Schema.Struct({ pageInfo: PageInfo }) }),
            ),
          }),
        ),
      }),
    ),
  ),
})

const decodePages = Schema.decodeUnknownEffect(ContextPages)

/**
 * A response the recorder cannot follow under `key`: `Malformed` when it lacks the shape of a pull
 * request lookup, `MissingCursor` when it reports another page of contexts without a cursor, and
 * `RepeatedCursor` when its cursor was already followed, which would page forever.
 */
export class UnreadablePage extends Schema.TaggedError<UnreadablePage>()("UnreadablePage", {
  detail: Schema.String,
  key: Schema.String,
  problem: Schema.Literals(["Malformed", "MissingCursor", "RepeatedCursor"]),
}) {}

const unreadable = (
  key: string,
  problem: UnreadablePage["problem"],
  detail: string,
): UnreadablePage => new UnreadablePage({ detail, key, problem })

/**
 * The cursor for the next page of check contexts under `key`, which must not be one of the
 * `followed` cursors. There is none when the repository, pull request, or status rollup is null,
 * or when GitHub reports no next page.
 */
export const nextCursor = Effect.fn("GitHubFixtures.nextCursor")(function* (
  response: Schema.Json,
  key: string,
  followed: ReadonlySet<string>,
) {
  const { data } = yield* Effect.mapError(
    decodePages(response),
    (error: { readonly message: string }) => unreadable(key, "Malformed", error.message),
  )

  if (!Object.hasOwn(data, key)) {
    return yield* unreadable(key, "Malformed", `The response has no answer under ${key}`)
  }

  const pageInfo = Option.fromNullishOr(data[key]).pipe(
    Option.flatMap((repository) => Option.fromNullishOr(repository.pullRequest)),
    Option.flatMap((node) => Option.fromNullishOr(node.statusCheckRollup)),
    Option.map((rollup) => rollup.contexts.pageInfo),
  )

  if (Option.isNone(pageInfo) || !pageInfo.value.hasNextPage) return Option.none<string>()

  const cursor = pageInfo.value.endCursor

  if (cursor === null) {
    return yield* unreadable(key, "MissingCursor", "hasNextPage is true without an endCursor")
  }

  if (followed.has(cursor)) {
    return yield* unreadable(key, "RepeatedCursor", `The cursor ${cursor} was already followed`)
  }

  return Option.some(cursor)
})
