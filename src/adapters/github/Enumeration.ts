/** GitHub enumeration values, including ones added after this version was written. */
import { Effect, Schema, SchemaGetter } from "effect"

/** A value GitHub reported for the enumeration `field` that this version does not know. */
export class Unrecognized extends Schema.Class<Unrecognized>("Unrecognized")({
  field: Schema.String,
  value: Schema.String,
}) {}

/**
 * GitHub's enumeration `field`, with the values this version knows. Any other text decodes to
 * `Unrecognized`, so a value GitHub adds later reaches the domain as unknown rather than failing
 * the whole pull request or passing for a value it is not.
 */
export const enumeration = <const Known extends readonly string[]>(
  field: string,
  known: Known,
): Schema.Union<
  readonly [Schema.Literals<Known>, Schema.decodeTo<typeof Unrecognized, Schema.String>]
> =>
  Schema.Union([
    Schema.Literals(known),
    Schema.String.pipe(
      Schema.decodeTo(Unrecognized, {
        decode: SchemaGetter.transform((value: string) => ({ field, value })),
        encode: SchemaGetter.transform((found: Readonly<{ value: string }>) => found.value),
      }),
    ),
  ])

/** The unrecognized values among `values`. */
export const unrecognizedAmong = (
  values: readonly (string | Unrecognized | null)[],
): Unrecognized[] => values.flatMap((value) => (value instanceof Unrecognized ? [value] : []))

/** How many distinct unrecognized values of one field are logged before the rest are not. */
export const loggedPerField = 20

/** What one report has not logged before: new values, and fields that just reached the limit. */
interface Unlogged {
  readonly values: readonly Unrecognized[]
  readonly full: readonly string[]
}

const logValue = (url: string, found: Unrecognized): Effect.Effect<void> =>
  Effect.logWarning("GitHub reported a value this version does not recognize").pipe(
    Effect.annotateLogs({ field: found.field, pullRequest: url, value: found.value }),
  )

const logFull = (field: string): Effect.Effect<void> =>
  Effect.logWarning("GitHub reported more unrecognized values than are logged").pipe(
    Effect.annotateLogs({ field, limit: loggedPerField }),
  )

/**
 * Logs each unrecognized value the first time this plugin instance sees it, with the pull request
 * it came from, so a GitHub addition can be noticed without a warning on every refresh. Up to
 * `loggedPerField` values are remembered per field; past that, one warning says the rest of that
 * field's values are not logged.
 */
export class UnrecognizedLog {
  private readonly seen = new Map<string, Set<string>>()

  /** Fields whose limit was reached, and said so. */
  private readonly full = new Set<string>()

  public report(url: string, values: readonly Unrecognized[]): Effect.Effect<void> {
    return Effect.flatMap(
      Effect.sync(() => this.unlogged(values)),
      ({ full, values: fresh }) =>
        Effect.andThen(
          Effect.forEach(fresh, (found) => logValue(url, found), { discard: true }),
          Effect.forEach(full, (field) => logFull(field), { discard: true }),
        ),
    )
  }

  /** Records `values` as seen, returning what has not been logged before. */
  private unlogged(values: readonly Unrecognized[]): Unlogged {
    const fresh: Unrecognized[] = []
    const full: string[] = []

    for (const found of values) {
      const known = this.seen.get(found.field) ?? new Set<string>()

      this.seen.set(found.field, known)

      if (known.has(found.value)) continue

      if (known.size < loggedPerField) {
        known.add(found.value)
        fresh.push(found)
      } else if (!this.full.has(found.field)) {
        this.full.add(found.field)
        full.push(found.field)
      }
    }

    return { full, values: fresh }
  }
}
