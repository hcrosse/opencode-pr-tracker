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

/** Whether a listing is still the latest to show its rows, and the latest listing at all. */
export interface Latest {
  readonly rows: () => boolean
  readonly listing: () => boolean
}

/**
 * Numbers listings and published updates. Each one supersedes the rows of the listings before it,
 * but only a newer listing supersedes a listing itself, so a listing that answers after a published
 * update can still say whether the view is current. The latest listing is awaited until it ends,
 * however it ends.
 */
export interface Listings {
  /**
   * Starts a listing, built from whether it is still the latest. The listing is awaited until the
   * returned effect ends, by answering, failing, dying or being interrupted.
   */
  readonly start: (listing: (latest: Latest) => Effect.Effect<void>) => Effect.Effect<void>
  readonly publish: () => void
  readonly awaited: () => boolean
}

export function listings(): Listings {
  const rows = newestFirst()
  const requests = newestFirst()
  let awaited = false

  return {
    awaited: () => awaited,
    publish: () => {
      rows.next()
    },
    start: (listing) => {
      const shown = rows.next()
      const id = requests.next()

      awaited = true

      // A newer listing owns the awaited flag once this one is superseded.
      return Effect.ensuring(
        listing({ listing: () => requests.isLatest(id), rows: () => rows.isLatest(shown) }),
        Effect.sync(() => {
          if (requests.isLatest(id)) awaited = false
        }),
      )
    },
  }
}
