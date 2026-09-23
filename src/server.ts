import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "opencode-pr-tracker",
  effect: () => Effect.void,
})
