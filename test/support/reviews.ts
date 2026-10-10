import type { Decision, Review } from "../../src/domain/Review.ts"

/** A review state with `unreplied` and `replied` threads; an incomplete one fetched 20 threads. */
export const reviewWith = (
  decision: Decision,
  [unreplied, replied]: readonly [number, number] = [0, 0],
  complete = true,
): Review => ({
  decision,
  threads: {
    complete,
    fetched: complete ? unreplied + replied : 20,
    replied,
    unknown: 0,
    unreplied,
  },
})
