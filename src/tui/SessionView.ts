/** The sidebar's view of one session at a time, and whether that view may be stale. */
import { Data, Effect, Option, Result } from "effect"
import { constVoid } from "effect/Function"
import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"

import type { View } from "../rpc.ts"
import { Liveness, SidebarState } from "../ui/Sidebar.tsx"
import type { Run } from "./Background.ts"
import { Update, type RequestFailed, type TrackerClientApi } from "./Client.ts"
import { listings, newestFirst } from "./Listings.ts"
import { leaseUntilLapse, renewWhileShown, type Renewed } from "./Renewal.ts"

/** What the session view last heard about the session's pull requests. */
type Listing = Data.TaggedEnum<{
  Loading: Record<never, never>
  Listed: { readonly view: View }
  Failed: { readonly message: string }
}>

const Listing = Data.taggedEnum<Listing>()

/** After a successful renewal, a view that was not live is out of date until it is listed again. */
const renewed = (liveness: Liveness): Liveness =>
  Liveness.$is("Live")(liveness) ? liveness : Liveness.OutOfDate()

/** After an update may have been missed. A view that is not refreshing stays so. */
const missed = (liveness: Liveness): Liveness =>
  Liveness.$is("Live")(liveness) ? Liveness.OutOfDate() : liveness

/** After the session's whole view arrived in an update. A view that is not refreshing stays so. */
const caughtUp = (liveness: Liveness): Liveness =>
  Liveness.$is("OutOfDate")(liveness) ? Liveness.Live() : liveness

/** How a listing answered. */
type Listed = Result.Result<Renewed<View>, RequestFailed>

/**
 * Liveness once a listing answers. A successful listing renewed the lease and carries the whole
 * view, so it is live unless the lease had lapsed even so. A failed one may have missed updates.
 */
function livenessAfter(result: Listed, previous: Liveness): Liveness {
  if (Result.isFailure(result)) return missed(previous)

  return result.success.holds ? Liveness.Live() : Liveness.NotRefreshing()
}

/**
 * The listing once a listing answers. A failed listing keeps the rows shown, out of date, so only
 * a session's first listing fails.
 */
function listingAfter(result: Listed, previous: Listing): Listing {
  if (Result.isSuccess(result)) return Listing.Listed({ view: result.success.answer })

  if (Listing.$is("Listed")(previous)) return previous

  return Listing.Failed({ message: result.failure.message })
}

/**
 * What the sidebar shows for the session, and whether it may be stale. Each listing and each
 * published update supersedes the listings before it. Events that call for a new listing return
 * true: the view is out of date, and nothing stops a listing from reaching the server. A renewal
 * does not call for one while a listing is still awaited, so a slow listing is not superseded by
 * the next renewal's. It does call for one while still loading with no listing awaited, since the
 * first listing then ended without an answer.
 */
interface SessionState {
  readonly listing: Accessor<Listing>
  readonly liveness: Accessor<Liveness>
  readonly start: () => void
  /** Lists the session with `request`, which renews its lease too. */
  readonly list: (request: Effect.Effect<Renewed<View>, RequestFailed>) => void
  readonly show: (view: View) => void
  readonly lapse: () => void
  readonly miss: () => boolean
  readonly renew: () => boolean
}

function sessionState(run: Run): SessionState {
  const [listing, setListing] = createSignal<Listing>(Listing.Loading())
  const [liveness, setLiveness] = createSignal<Liveness>(Liveness.Live())
  const requests = listings()

  const step = (next: (liveness: Liveness) => Liveness): boolean =>
    Liveness.$is("OutOfDate")(setLiveness(next))

  return {
    lapse: () => {
      setLiveness(Liveness.NotRefreshing())
    },
    list: (request) => {
      run(
        requests.start((isLatest) =>
          Effect.map(Effect.result(request), (result) => {
            if (!isLatest()) return

            setListing((previous) => listingAfter(result, previous))
            setLiveness((previous) => livenessAfter(result, previous))
          }),
        ),
      )
    },
    listing,
    liveness,
    miss: () => step(missed),
    renew: () => (step(renewed) || Listing.$is("Loading")(listing())) && !requests.awaited(),
    show: (view) => {
      requests.supersede()
      setListing(Listing.Listed({ view }))
      step(caughtUp)
    },
    start: () => {
      setListing(Listing.Loading())
      setLiveness(Liveness.Live())
    },
  }
}

/**
 * Lists the session and renews its lease until the owning reactive scope is cleaned up, returning
 * how to list it again. A successful renewal lists the session again when it is out of date or was
 * not refreshing, since updates may have been missed. Renewals from a visit that `isCurrent` no
 * longer accepts are ignored.
 */
function visit(
  sessionID: string,
  context: { readonly tracker: TrackerClientApi; readonly run: Run; readonly state: SessionState },
  isCurrent: () => boolean,
): () => void {
  const { run, state, tracker } = context
  const lease = leaseUntilLapse(run, state.lapse)

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
 * Shows each update for the shown session. An unreadable update marks the session out of date
 * when it names the session or names none, since it may have been this session's, and lists the
 * session again unless it is not refreshing, in which case the next successful renewal will.
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

        if (state.miss()) listAgain()
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
      Failed: ({ message }) => SidebarState.Failed({ message }),
      Listed: ({ view }) => SidebarState.Ready({ liveness: state.liveness(), view }),
      Loading: () => SidebarState.Loading(),
    }),
  )
}
