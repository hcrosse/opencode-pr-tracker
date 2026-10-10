/** Numbering that lets later requests supersede earlier ones. */
import { Effect } from "effect"

/** Numbers requests or visits; each one started supersedes those before it. */
export interface Sequence {
  readonly next: () => number
  readonly isLatest: (request: number) => boolean
}

export function newestFirst(): Sequence {
  let latest = 0

  return {
    isLatest: (request) => request === latest,
    next: () => {
      latest += 1

      return latest
    },
  }
}

/**
 * Numbers listings. Each listing and each published update supersedes the listings before it, and
 * the latest listing is awaited until it ends, however it ends.
 */
export interface Listings {
  /**
   * Starts a listing, built from whether it is still the latest. The listing is awaited until the
   * returned effect ends, by answering, failing, dying or being interrupted.
   */
  readonly start: (listing: (isLatest: () => boolean) => Effect.Effect<void>) => Effect.Effect<void>
  readonly supersede: () => void
  readonly awaited: () => boolean
}

export function listings(): Listings {
  const requests = newestFirst()
  let awaited = false

  return {
    awaited: () => awaited,
    start: (listing) => {
      const id = requests.next()

      awaited = true

      // A newer listing or update owns the awaited flag once this one is superseded.
      return Effect.ensuring(
        listing(() => requests.isLatest(id)),
        Effect.sync(() => {
          if (requests.isLatest(id)) awaited = false
        }),
      )
    },
    supersede: () => {
      awaited = false
      requests.next()
    },
  }
}
