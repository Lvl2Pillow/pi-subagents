import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	PersistentChatStore,
	clampSlotCount,
	DEFAULT_PERSISTENT_SLOT_COUNT,
	MAX_PERSISTENT_SLOT_COUNT,
} from "../../src/persistent/store.ts";
import { decideInputAction } from "../../src/persistent/routing.ts";
import {
	PERSISTENT_STATUS_KEY,
	buildPersistentStatus,
} from "../../src/persistent/status.ts";
import { loadState, saveState } from "../../src/persistent/persistence.ts";

describe("PersistentChatStore", () => {
	it("pre-creates all channels: slots 1..3 occupied, no session, idle", () => {
		const store = new PersistentChatStore();
		assert.equal(store.getSlotCount(), 3);
		assert.equal(store.getAgentCount(), 3);
		assert.deepEqual(
			store.getAgents().map((entry) => entry.index),
			[1, 2, 3],
		);
		assert.deepEqual(
			store.getAgents().map((entry) => entry.id),
			["persist-1", "persist-2", "persist-3"],
		);
		for (const entry of store.getAgents()) {
			assert.equal(entry.sessionFile, null);
			assert.equal(entry.lastState, "idle");
			assert.equal(entry.lastOutput, undefined);
		}
		assert.equal(store.getTarget(), 0);
	});

	it("accepts a configurable slot count and clamps it to 1..8", () => {
		const store = new PersistentChatStore(5);
		assert.equal(store.getSlotCount(), 5);
		assert.equal(store.getAgentCount(), 5);
		assert.deepEqual(
			store.getAgents().map((entry) => entry.index),
			[1, 2, 3, 4, 5],
		);
		assert.equal(new PersistentChatStore(0).getSlotCount(), 1);
		assert.equal(new PersistentChatStore(99).getSlotCount(), 8);
		assert.equal(new PersistentChatStore(-3).getSlotCount(), 1);
	});

	it("clampSlotCount normalizes values", () => {
		assert.equal(clampSlotCount(3), 3);
		assert.equal(clampSlotCount(1), 1);
		assert.equal(clampSlotCount(8), 8);
		assert.equal(clampSlotCount(0), 1);
		assert.equal(clampSlotCount(12), 8);
		assert.equal(clampSlotCount(3.7), 3);
		assert.equal(clampSlotCount(Number.NaN), DEFAULT_PERSISTENT_SLOT_COUNT);
		assert.equal(
			clampSlotCount(Number.POSITIVE_INFINITY),
			DEFAULT_PERSISTENT_SLOT_COUNT,
		);
		assert.equal(
			clampSlotCount(Number.NEGATIVE_INFINITY),
			DEFAULT_PERSISTENT_SLOT_COUNT,
		);
		assert.equal(MAX_PERSISTENT_SLOT_COUNT, 8);
	});

	it("setSessionFile records the lazy-spawned session file and emits change", () => {
		const store = new PersistentChatStore();
		let changes = 0;
		store.onChange(() => {
			changes += 1;
		});
		assert.equal(store.setSessionFile(1, "/tmp/persist-1.jsonl"), true);
		assert.equal(store.getAgent(1)?.sessionFile, "/tmp/persist-1.jsonl");
		assert.equal(changes, 1);
		assert.equal(store.setSessionFile(99, "x"), false);
		assert.equal(store.setSessionFile(0, "y"), false);
	});

	it("setRunState tracks transient run state on the entry", () => {
		const store = new PersistentChatStore();
		assert.equal(store.setRunState(1, "running"), true);
		assert.equal(store.getAgent(1)?.lastState, "running");
		assert.equal(store.setRunState(1, "success"), true);
		assert.equal(store.getAgent(1)?.lastState, "success");
		assert.equal(store.setRunState(99, "running"), false);
	});

	it("setRunOutput records the last run output for the fleet UI", () => {
		const store = new PersistentChatStore();
		assert.equal(store.setRunOutput(1, "final summary"), true);
		assert.equal(store.getAgent(1)?.lastOutput, "final summary");
		assert.equal(store.setRunOutput(99, "nope"), false);
		assert.equal(store.getAgent(1)?.lastOutput, "final summary");
	});

	it("getAgent returns the entry or undefined for out-of-range slots", () => {
		const store = new PersistentChatStore();
		assert.equal(store.getAgent(1)?.id, "persist-1");
		assert.equal(store.getAgent(0), undefined);
		assert.equal(store.getAgent(4), undefined);
		assert.equal(store.getAgent(-1), undefined);
	});

	it("cycle wraps main → 1 → 2 → 3 → main", () => {
		const store = new PersistentChatStore();
		store.cycle();
		assert.equal(store.getTarget(), 1);
		store.cycle();
		assert.equal(store.getTarget(), 2);
		store.cycle();
		assert.equal(store.getTarget(), 3);
		store.cycle();
		assert.equal(store.getTarget(), 0);
		store.cycle();
		assert.equal(store.getTarget(), 1);
	});

	it("cycle covers every channel for a custom slot count", () => {
		const store = new PersistentChatStore(2);
		const seen: number[] = [];
		for (let i = 0; i < 6; i++) {
			store.cycle();
			seen.push(store.getTarget());
		}
		assert.deepEqual(seen, [1, 2, 0, 1, 2, 0]);
	});

	it("setTarget accepts any channel, rejects out-of-range values", () => {
		const store = new PersistentChatStore();
		assert.equal(store.setTarget(0), true);
		assert.equal(store.setTarget(1), true);
		assert.equal(store.setTarget(3), true);
		assert.equal(store.setTarget(4), false);
		assert.equal(store.setTarget(-1), false);
		assert.equal(store.setTarget(1.5), false);
		assert.equal(store.getTarget(), 3);
	});

	it("reset recreates the full channel set and clears the target", () => {
		const store = new PersistentChatStore();
		store.setSessionFile(2, "/tmp/x.jsonl");
		store.setRunOutput(2, "old output");
		store.setTarget(2);
		store.reset();
		assert.equal(store.getAgentCount(), 3);
		assert.equal(store.getTarget(), 0);
		assert.equal(store.getAgent(2)?.sessionFile, null);
		assert.equal(store.getAgent(2)?.lastOutput, undefined);
	});

	describe("resetChannel", () => {
		it("clears the session file, run state and output but keeps id/index/model", () => {
			const store = new PersistentChatStore();
			store.setSessionFile(2, "/tmp/persist-2.jsonl");
			store.setModel(2, "anthropic/claude-sonnet-4");
			store.setRunState(2, "success");
			store.setRunOutput(2, "done");
			assert.equal(store.resetChannel(2), true);
			const entry = store.getAgent(2);
			assert.ok(entry);
			assert.equal(entry.sessionFile, null);
			assert.equal(entry.lastState, "idle");
			assert.equal(entry.lastOutput, undefined);
			assert.equal(entry.model, "anthropic/claude-sonnet-4");
			assert.equal(entry.id, "persist-2");
		});

		it("returns false for out-of-range indexes", () => {
			const store = new PersistentChatStore();
			assert.equal(store.resetChannel(0), false);
			assert.equal(store.resetChannel(4), false);
		});

		it("emits onChange exactly once per reset", () => {
			const store = new PersistentChatStore();
			let changes = 0;
			store.onChange(() => {
				changes += 1;
			});
			store.resetChannel(1);
			assert.equal(changes, 1);
		});
	});

	it("onChange fires on setSessionFile, cycle, setTarget, reset, and resetChannel", () => {
		const store = new PersistentChatStore();
		let changes = 0;
		const unsubscribe = store.onChange(() => {
			changes += 1;
		});
		store.setSessionFile(1, "/tmp/p1.jsonl");
		store.cycle();
		store.setTarget(0);
		store.resetChannel(2);
		store.reset();
		assert.equal(changes, 5);
		unsubscribe();
		store.cycle();
		assert.equal(changes, 5);
	});
});

describe("decideInputAction", () => {
	it("routes to the main agent when target is 0", () => {
		const decision = decideInputAction({
			text: "hello",
			hasImages: false,
			target: 0,
			agentCount: 3,
		});
		assert.deepEqual(decision, { action: "continue" });
	});

	it("routes to the main agent when target exceeds agent count", () => {
		const decision = decideInputAction({
			text: "hello",
			hasImages: false,
			target: 4,
			agentCount: 3,
		});
		assert.deepEqual(decision, { action: "continue" });
	});

	it("routes targeted input to a persistent run when a subagent is targeted", () => {
		const decision = decideInputAction({
			text: "hello sub",
			hasImages: false,
			target: 2,
			agentCount: 3,
		});
		assert.deepEqual(decision, {
			action: "handled",
			run: { agentIndex: 2, text: "hello sub" },
		});
	});

	it("consumes whitespace silently when a subagent is targeted", () => {
		const decision = decideInputAction({
			text: "   ",
			hasImages: false,
			target: 1,
			agentCount: 3,
		});
		assert.deepEqual(decision, { action: "handled" });
	});

	it("consumes and notifies when images are attached to a subagent target", () => {
		const decision = decideInputAction({
			text: "look at this",
			hasImages: true,
			target: 1,
			agentCount: 3,
		});
		assert.equal(decision.action, "handled");
		assert.equal(decision.run, undefined);
		assert.ok(decision.notify && decision.notify.length > 0);
	});
});

describe("buildPersistentStatus", () => {
	it("renders speaker icon plus target number", () => {
		assert.equal(buildPersistentStatus(0), "🔊 0");
		assert.equal(buildPersistentStatus(1), "🔊 1");
		assert.equal(buildPersistentStatus(5), "🔊 5");
	});

	it("exposes the status key used for the footer", () => {
		assert.equal(PERSISTENT_STATUS_KEY, "persistent.target");
	});
});

describe("PersistentChatStore.replace", () => {
	it("pads missing entries with fresh channels and emits change", () => {
		const store = new PersistentChatStore();
		let changes = 0;
		store.onChange(() => {
			changes += 1;
		});
		store.replace([{ sessionFile: "/tmp/p1.jsonl" }], 1);
		assert.equal(store.getAgent(1)?.sessionFile, "/tmp/p1.jsonl");
		// Channels 2 and 3 did not exist in the persisted file: fresh.
		assert.equal(store.getAgent(2)?.sessionFile, null);
		assert.equal(store.getAgent(3)?.sessionFile, null);
		assert.equal(store.getAgentCount(), 3);
		assert.equal(store.getTarget(), 1);
		assert.equal(changes, 1);
	});

	it("truncates entries beyond slotCount", () => {
		const store = new PersistentChatStore(2);
		store.replace(
			[
				{ sessionFile: "/tmp/p1.jsonl" },
				{ sessionFile: "/tmp/p2.jsonl" },
				{ sessionFile: "/tmp/p3.jsonl" },
			],
			0,
		);
		assert.equal(store.getAgentCount(), 2);
		assert.equal(store.getAgent(2)?.sessionFile, "/tmp/p2.jsonl");
	});

	it("replace carries sessionFile and model", () => {
		const store = new PersistentChatStore();
		store.replace(
			[
				{
					sessionFile: "/tmp/p1.jsonl",
					model: "anthropic/claude-sonnet-4",
				},
			],
			0,
		);
		assert.equal(store.getAgent(1)?.sessionFile, "/tmp/p1.jsonl");
		assert.equal(store.getAgent(1)?.model, "anthropic/claude-sonnet-4");
		assert.equal(store.getAgent(2)?.sessionFile, null);
	});

	it("clamps out-of-range targetIndex into the channel range", () => {
		const store = new PersistentChatStore(2);
		store.replace([], 3);
		// Every channel is occupied, so an out-of-range target clamps to the
		// last channel rather than falling back to main.
		assert.equal(store.getTarget(), 2);
		store.replace([], 99);
		assert.equal(store.getTarget(), 2);
		store.replace([], -1);
		assert.equal(store.getTarget(), 0);
	});
});

describe("persistence (loadState/saveState)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-test-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when the file does not exist", () => {
		assert.equal(loadState(path.join(tmpDir, "missing.json")), null);
	});

	it("round-trips v2 entries through save and load", () => {
		const file = path.join(tmpDir, "state.json");
		saveState(
			file,
			[
				{ id: "persist-1", sessionFile: "/tmp/p1.jsonl" },
				{ id: "persist-2", sessionFile: null },
			],
			2,
		);
		const loaded = loadState(file);
		assert.deepEqual(loaded, {
			version: 2,
			entries: [
				{ id: "persist-1", sessionFile: "/tmp/p1.jsonl" },
				{ id: "persist-2", sessionFile: null },
			],
			targetIndex: 2,
		});
	});

	it("loads v1 ids format, migrating to fresh channels with no session file", () => {
		const file = path.join(tmpDir, "state.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				ids: ["persist-1", "persist-2"],
				targetIndex: 1,
			}),
			"utf-8",
		);
		const loaded = loadState(file);
		assert.deepEqual(loaded, {
			version: 1,
			entries: [
				{ id: "persist-1", sessionFile: null },
				{ id: "persist-2", sessionFile: null },
			],
			targetIndex: 1,
		});
	});

	it("tolerates a legacy mode field (default/clone) but does not carry it", () => {
		const file = path.join(tmpDir, "state.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 2,
				entries: [
					{ id: "persist-1", mode: "clone", sessionFile: "/tmp/p1.jsonl" },
					{ id: "persist-2", mode: "default", sessionFile: null },
				],
				targetIndex: 0,
			}),
			"utf-8",
		);
		const loaded = loadState(file);
		assert.deepEqual(loaded, {
			version: 2,
			entries: [
				{ id: "persist-1", sessionFile: "/tmp/p1.jsonl" },
				{ id: "persist-2", sessionFile: null },
			],
			targetIndex: 0,
		});
	});

	it("rejects v2 files with an unknown legacy mode value", () => {
		const file = path.join(tmpDir, "state.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 2,
				entries: [{ id: "persist-1", mode: "bogus", sessionFile: null }],
				targetIndex: 0,
			}),
			"utf-8",
		);
		assert.equal(loadState(file), null);
	});

	it("strips unknown fields from loaded v2 state", () => {
		const file = path.join(tmpDir, "state.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 2,
				entries: [
					{
						id: "persist-1",
						sessionFile: "/tmp/p1.jsonl",
						extra: 1,
					},
				],
				nextId: 99,
				targetIndex: 1,
			}),
			"utf-8",
		);
		const loaded = loadState(file);
		assert.deepEqual(loaded, {
			version: 2,
			entries: [{ id: "persist-1", sessionFile: "/tmp/p1.jsonl" }],
			targetIndex: 1,
		});
	});

	it("returns null on corrupt JSON", () => {
		const file = path.join(tmpDir, "state.json");
		fs.writeFileSync(file, "{not json", "utf-8");
		assert.equal(loadState(file), null);
	});

	it("returns null on wrong version", () => {
		const file = path.join(tmpDir, "state.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ version: 99, ids: [], targetIndex: 0 }),
			"utf-8",
		);
		assert.equal(loadState(file), null);
	});

	it("returns null on invalid v2 entry types", () => {
		const file = path.join(tmpDir, "state.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 2,
				entries: [{ id: 5, sessionFile: null }],
				targetIndex: 0,
			}),
			"utf-8",
		);
		assert.equal(loadState(file), null);
	});

	it("returns null on negative or non-integer targetIndex", () => {
		const file = path.join(tmpDir, "state.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ version: 2, entries: [], targetIndex: -1 }),
			"utf-8",
		);
		assert.equal(loadState(file), null);
	});

	it("save uses atomic write (no leftover .tmp)", () => {
		const file = path.join(tmpDir, "state.json");
		saveState(file, [{ id: "persist-1", sessionFile: null }], 1);
		assert.ok(fs.existsSync(file));
		assert.equal(fs.existsSync(`${file}.tmp`), false);
	});

	it("create the parent directory if it does not exist", () => {
		const file = path.join(tmpDir, "nested", "dir", "state.json");
		saveState(file, [{ id: "persist-1", sessionFile: null }], 1);
		assert.ok(fs.existsSync(file));
	});
});
