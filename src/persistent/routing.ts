/**
 * Pure input-routing decisions for the persistent-chat input target.
 */

export type RoutingAction = "continue" | "handled";

export interface RoutingDecision {
	action: RoutingAction;
	/** When set, the input should be routed to the persistent subagent as a real run. */
	run?: { agentIndex: number; text: string };
	/** When set, the input is consumed and the user should be notified. */
	notify?: string;
}

export interface RouteInputContext {
	text: string;
	hasImages: boolean;
	/** 0 = main agent; 1..N = persistent subagents in spawn order. */
	target: number;
	agentCount: number;
}

export function decideInputAction(input: RouteInputContext): RoutingDecision {
	if (input.target === 0 || input.target > input.agentCount) {
		return { action: "continue" };
	}
	if (!input.text.trim()) {
		// Consume silently — nothing to echo.
		return { action: "handled" };
	}
	if (input.hasImages) {
		return {
			action: "handled",
			notify: "Image input is not supported by persistent subagents.",
		};
	}
	return {
		action: "handled",
		run: { agentIndex: input.target, text: input.text },
	};
}
