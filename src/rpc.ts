/**
 * The RPC contract between the server plugin and its clients, including the terminal plugin.
 * Schemas are Standard Schema so both Effect and Promise clients can use them.
 */
import { Rpc } from "@opencode/plugin/rpc"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { Schema } from "effect"

import { PullRequestRef } from "./domain/PullRequest.ts"
import { Status } from "./domain/Snapshot.ts"
import { Membership } from "./domain/StackLayout.ts"

export const Layout = Schema.Literals(["default", "compact"])

export type Layout = typeof Layout.Type

export const EntryView = Schema.Struct({
  attachedAt: Schema.Int,
  membership: Schema.NullOr(Membership),
  ref: PullRequestRef,
  status: Status,
})

export type EntryView = typeof EntryView.Type

/** A session's attached pull requests, in display order, with the configured sidebar layout. */
export const View = Schema.Struct({
  entries: Schema.Array(EntryView),
  layout: Layout,
  sessionID: Schema.String,
})

export type View = typeof View.Type

/** A view as clients receive it: plain JSON data. */
export type ViewData = typeof View.Encoded

const Session = Schema.Struct({ sessionID: Schema.String })

/** A pull request URL, with or without `https://`, or a number in the session's repository. */
const Target = Schema.Struct({ sessionID: Schema.String, target: Schema.String })

/** The outcome of a change, with a message for the person who asked, and the session's new view. */
export const Changed = Schema.Struct({ message: Schema.String, view: View })

export type Changed = typeof Changed.Type

/** A request that could not be carried out, with a message for the person who made it. */
const Rejected = Schema.Struct({ message: Schema.String })

/**
 * The wire form of `schema`: plain JSON data, validated by the plugin's own copy of Effect.
 * OpenCode would handle an Effect schema with its own copy, which can reject values this one
 * accepts, and it sends only JSON, so decoded values such as class instances cannot cross.
 */
function portable<S extends Schema.Top>(schema: S): StandardSchemaV1<S["Encoded"], S["Encoded"]> {
  return { "~standard": Schema.toStandardSchemaV1(Schema.toEncoded(schema))["~standard"] }
}

export const PullRequestTracker = Rpc.define({
  events: {
    updated: { schema: portable(View) },
  },
  id: "opencode-pr-tracker",
  methods: {
    attach: {
      errors: { rejected: portable(Rejected) },
      input: portable(Target),
      output: portable(Changed),
    },
    detach: {
      errors: { rejected: portable(Rejected) },
      input: portable(Target),
      output: portable(Changed),
    },
    list: {
      errors: { rejected: portable(Rejected) },
      input: portable(Session),
      output: portable(View),
    },
    refresh: {
      errors: { rejected: portable(Rejected) },
      input: portable(Session),
      output: portable(View),
    },
  },
})

export type PullRequestTracker = typeof PullRequestTracker
