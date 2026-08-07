import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PersistentChatStore } from "../../src/persistent/store.ts";
import {
	registerPersistentExternalRuns,
	PERSISTENT_EXTERNAL_RUN_SOURCE,
} from "../../src/persistent/external-runs.ts";
import { snapshotExternalRuns } from "../../src/api/external-runs.ts";

const unregister: Array<() => void> = [];

afterEach(() => {
	while (unregister.length) unregister.pop()?.();
});

function register(store: PersistentChatStore, sessionId: () => string | undefined): void {
	unregister.push(registerPersistentExternalRuns({ store, getSessionId: sessionId }));
}

describe("persistent external-runs provider", () => {
	it("exposes running and terminal channel state as external runs", () => {
		const store = new PersistentChatStore();
		store.setTarget(1);
		store.setRunState(1, "running");
		store.setRunState(2, "success");
		store.setRunState(3, "fail");
		register(store, () => "main-session-1");

		const runs = snapshotExternalRuns("main-session-1");
		assert.equal(runs.length, 3);
		const byId = new Map(runs.map((run) => [run.id, run]));
		assert.equal(byId.get("persist-1")?.state, "running");
		assert.equal(byId.get("persist-2")?.state, "completed");
		assert.equal(byId.get("persist-3")?.state, "failed");
		for (const run of runs) {
			assert.equal(run.source, PERSISTENT_EXTERNAL_RUN_SOURCE);
			assert.equal(run.sessionId, "main-session-1");
		}
	});

	it("omits idle channels and other sessions", () => {
		const store = new PersistentChatStore();
		store.setTarget(1);
		store.setRunState(1, "running");
		register(store, () => "main-session-1");

		// The other session never sees this session's channels.
		assert.equal(snapshotExternalRuns("main-session-2").length, 0);
		// Idle channels in the bound session are omitted too.
		assert.equal(snapshotExternalRuns("main-session-1").length, 1);
	});

	it("reports nothing before any session binds", () => {
		const store = new PersistentChatStore();
		store.setTarget(1);
		store.setRunState(1, "running");
		register(store, () => undefined);
		assert.equal(snapshotExternalRuns("main-session-1").length, 0);
	});
});
