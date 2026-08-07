/**
 * External-runs provider for persistent channels.
 *
 * Surfaces channel activity through upstream's observational
 * `external-runs` registry (exported as `pi-subagents/external-runs`), so
 * active persistent subagents are visible to any external-runs consumer
 * (host FleetView, Herdr, or third-party tooling) without duplicating the
 * fork's own fleet rendering. The registry is read-only observation: the
 * fork keeps full lifecycle ownership of the run children.
 */

import { registerExternalRunProvider } from "../api/external-runs.ts";
import type { ExternalRun } from "../api/external-runs.ts";
import type { PersistentChatStore } from "./store.ts";

export interface PersistentExternalRunsOptions {
	store: PersistentChatStore;
	/** Current main-agent session id (undefined before any session binds). */
	getSessionId: () => string | undefined;
}

/** External-run source label for persistent channels. */
export const PERSISTENT_EXTERNAL_RUN_SOURCE = "persistent";

/**
 * Register a read-only provider mapping each channel's latest state onto an
 * external run. Idle channels are omitted; running/success/fail map to
 * running/completed/failed. Returns an unregister function.
 */
export function registerPersistentExternalRuns(
	options: PersistentExternalRunsOptions,
): () => void {
	const { store, getSessionId } = options;
	return registerExternalRunProvider({
		name: "persistent-channels",
		listExternalRuns(): readonly ExternalRun[] {
			const sessionId = getSessionId();
			if (!sessionId) return [];
			const runs: ExternalRun[] = [];
			for (const agent of store.getAgents()) {
				if (agent.lastState === "idle") continue;
				runs.push({
					id: agent.id,
					sessionId,
					source: PERSISTENT_EXTERNAL_RUN_SOURCE,
					state:
						agent.lastState === "running"
							? "running"
							: agent.lastState === "success"
								? "completed"
								: "failed",
				});
			}
			return runs;
		},
	});
}
