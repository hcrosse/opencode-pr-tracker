import { defineRule } from "@oxlint/plugins";

import {
	isInsideBroadEffectHandler,
	isTagMember,
	tagMemberFromComparison,
} from "../shared/tagged-values.ts";

export const noManualTagComparisonRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Use Effect Match or Predicate helpers instead of manually branching on `_tag`.",
		},
		messages: {
			manualComparison:
				"Use a type-checked union helper (Schema.TaggedUnion.match or Data.taggedEnum.$match/$is) or an Effect guard such as Result.isFailure. Do not use Predicate.isTagged with a literal.",
			manualSwitch:
				"Use Schema.TaggedUnion.match or Data.taggedEnum.$match for exhaustive branches. For one case, use Data.taggedEnum.$is or an Effect guard such as Option.isSome.",
		},
	},
	createOnce(context) {
		return {
			BinaryExpression(node) {
				if (
					tagMemberFromComparison(node) === undefined ||
					isInsideBroadEffectHandler(node)
				) {
					return;
				}
				context.report({ node, messageId: "manualComparison" });
			},
			SwitchStatement(node) {
				if (
					!isTagMember(node.discriminant) ||
					isInsideBroadEffectHandler(node)
				) {
					return;
				}
				context.report({ node, messageId: "manualSwitch" });
			},
		};
	},
});
