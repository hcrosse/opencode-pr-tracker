/** The sidebar's view of one session at a time, and whether that view may be stale. */
import { Data, Effect, Option, Result } from "effect"
import { constVoid } from "effect/Function"
import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"

import type { View } from "../rpc.ts"
import { Liveness, SidebarState } from "../ui/Sidebar.tsx"
import type { Run } from "./Background.ts"
import { Update, type FailureReason, type RequestFailed, type TrackerClientApi } from "./Client.ts"
import { listings, newestFirst } from "./Listings.ts"
import { leaseUntilLapse, renewWhileShown, type Renewed } from "./Renewal.ts"

/** What the session view last heard about the session's pull requests. */
type Listing = Data.TaggedEnum<{
  Loading: Record<never, never>
  Listed: { readonly view: View }
  Failed: { readonly reason: FailureReason; readonly message: string }
}>

const Listing = Data.taggedEnum<Listing>()

/** How a listing answered. */
type Listed = Result.Result<Renewed<View>, RequestFailed>

/**
 * Liveness once a listing answers. A successful listing renewed the lease and carries the whole
 * view, so it is live unless the lease had lapsed even so. A failed one may have missed updates.
 */
const livenessAfter = (result: Listed): Liveness =>
  Result.isSuccess(result) && result.success.holds ? Liveness.Live() : Liveness.Stale()

/**
 * The listing once a listing answers. A failed listing keeps the rows shown, stale, so only a
 * session's first listing fails.
 */
function listingAfter(result: Listed, previous: Listing): Listing {
  if (Result.isSuccess(result)) return Listing.Listed({ view: result.success.answer })

  if (Listing.$is("Listed")(previous)) return previous

  return Listing.Failed({ message: result.failure.message, reason: result.failure.reason })
}

/**
 * What the sidebar shows for the session, and whether it may be stale. Each listing and each
 * published update supersedes the rows of the listings before it. A published update leaves a
 * stale view stale, since it does not renew the lease, but a listing it superseded still clears
 * stale when it succeeds, unless a newer listing started meanwhile; a failed one leaves the
 * newer rows' liveness alone. A successful renewal calls for a new listing while
 * the view is stale, or still loading after the first listing ended without an answer, but not
 * while a listing is still awaited, so a slow listing is not superseded by the next renewal's.
 */
interface SessionState {
  readonly listing: Accessor<Listing>
  readonly liveness: Accessor<Liveness>
  readonly start: () => void
  /** Lists the session with `request`, which renews its lease too. */
  readonly list: (request: Effect.Effect<Renewed<View>, RequestFailed>) => void
  readonly show: (view: View) => void
  /** Marks the view stale, as after the lease lapsed or an update may have been missed. */
  readonly stale: () => void
  readonly renew: () => boolean
}

function sessionState(run: Run): SessionState {
  const [listing, setListing] = createSignal<Listing>(Listing.Loading())
  const [liveness, setLiveness] = createSignal<Liveness>(Liveness.Live())
  const requests = listings()

  return {
    list: (request) => {
      run(
        requests.start((latest) =>
          Effect.map(Effect.result(request), (result) => {
            if (latest.rows()) setListing((previous) => listingAfter(result, previous))

            if (latest.listing() && (Result.isSuccess(result) || latest.rows()))
              setLiveness(livenessAfter(result))
          }),
        ),
      )
    },
    listing,
    liveness,
    renew: () =>
      (Liveness.$is("Stale")(liveness()) || Listing.$is("Loading")(listing())) &&
      !requests.awaited(),
    show: (view) => {
      requests.publish()
      setListing(Listing.Listed({ view }))
    },
    stale: () => {
      setLiveness(Liveness.Stale())
    },
    start: () => {
      setListing(Listing.Loading())
      setLiveness(Liveness.Live())
    },
  }
}

/**
 * Lists the session and renews its lease until the owning reactive scope is cleaned up, returning
 * how to list it again. A successful renewal lists the session again when it is stale, since
 * updates may have been missed. Renewals from a visit that `isCurrent` no longer accepts are
 * ignored.
 */
function visit(
  sessionID: string,
  context: { readonly tracker: TrackerClientApi; readonly run: Run; readonly state: SessionState },
  isCurrent: () => boolean,
): () => void {
  const { run, state, tracker } = context
  const lease = leaseUntilLapse(run, state.stale)

  const list = (): void => {
    state.list(lease.renewing(tracker.list(sessionID)))
  }

  state.start()
  list()
  renewWhileShown(lease.renewing(tracker.watch(sessionID)), run, () => {
    if (isCurrent() && state.renew()) list()
  })

  return list
}

/**
 * Shows each update for the shown session. An unreadable update marks the session stale when it
 * names the session or names none, since it may have been this session's, and lists the session
 * again straight away.
 */
function follow(
  sessionID: Accessor<string>,
  state: SessionState,
  listAgain: () => void,
): (update: Update) => void {
  return (update) => {
    const current = sessionID()

    Update.$match(update, {
      Published: ({ view }) => {
        if (view.sessionID === current) state.show(view)
      },
      Unreadable: ({ sessionID: addressed }) => {
        if (Option.exists(addressed, (id) => id !== current)) return

        state.stale()
        listAgain()
      },
    })
  }
}

/**
 * The session's view, owned by the server: listed when the sidebar is shown or switches session,
 * then replaced by each published update. While the session is shown, its lease is renewed so the
 * server keeps refreshing it. A shown view says when it may be stale; see `Liveness`.
 */
export function sessionView(
  sessionID: Accessor<string>,
  tracker: TrackerClientApi,
  run: Run,
): Accessor<SidebarState> {
  const state = sessionState(run)
  const visits = newestFirst()
  let listAgain: () => void = constVoid

  onCleanup(
    tracker.onUpdate(
      follow(sessionID, state, () => {
        listAgain()
      }),
    ),
  )
  createEffect(
    on(sessionID, (current) => {
      const latest = visits.next()

      listAgain = visit(current, { run, state, tracker }, () => visits.isLatest(latest))
    }),
  )

  return createMemo(() =>
    Listing.$match(state.listing(), {
      Failed: ({ message, reason }) => SidebarState.Failed({ message, reason }),
      Listed: ({ view }) => SidebarState.Ready({ liveness: state.liveness(), view }),
      Loading: () => SidebarState.Loading(),
    }),
  )
}
