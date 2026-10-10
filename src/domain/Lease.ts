import { Duration } from "effect"

/**
 * How long the server keeps refreshing a session after its lease was last renewed. Watching or
 * listing the session renews it.
 */
export const leaseDuration = Duration.seconds(45)
