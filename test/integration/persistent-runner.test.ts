/**
 * Integration tests for the persistent-runner launch timing, channel reset
 * (/new) and session cloning (/clone).
 *
 * Uses the local createMockPi() helper to simulate the pi CLI child, so the
 * background subagent run is exercised end-to-end (spawn → mock child →
 * finalize) without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";
import { PersistentChatStore } from "../../src/persistent/store.ts";
import {
	acquireSessionLease,
	inspectSessionLease,
} from "../../src/runs/shared/session-lease.ts";

interface RunnerModule {
	setPersistentRunnerActive: (value: boolean) => void;
	enqueuePersistentPrompt: (
		pi: ExtensionAPI,
		store: PersistentChatStore,
		ctx: ExtensionContext,
		text: string,
		extensionRoot: string,
	) => void;
	flushPendingRuns: (
		pi: ExtensionAPI,
		store: PersistentChatStore,
		ctx: ExtensionContext,
		extensionRoot: string,
		options?: { allowWhileStreaming?: boolean },
	) => void;
	interruptPersistentRun: (entryIndex: number) => boolean;
	cancelQueuedPrompt: (entryIndex: number) => boolean;
	resetChannelSession: (
		store: PersistentChatStore,
		ctx: ExtensionContext,
		entryIndex: number,
	) => void;
	cloneMainSessionToChannel: (
		store: PersistentChatStore,
		ctx: ExtensionContext,
		entryIndex: number,
	) => void;
}

const runner = await tryImport<RunnerModule>("./src/persistent/runner.ts");

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(
	condition: () => boolean,
	label: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (condition()) return;
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for: ${label}`);
		}
		await sleep(10);
	}
}

describe(
	"persistent runner launch timing",
	{ skip: !runner ? "pi packages not available" : undefined },
	() => {
		let tempDir: string;
		let mockPi: MockPi;

		before(() => {
			mockPi = createMockPi();
			mockPi.install();
		});

		after(() => {
			mockPi.uninstall();
		});

		beforeEach(() => {
			tempDir = createTempDir();
			mockPi.reset();
			// Log writes follow PI_SUBAGENTS_STATE_DIR so integration runs never
			// touch the real extension root.
			process.env.PI_SUBAGENTS_STATE_DIR = tempDir;
			// The runner keeps module-level queue state; reset it between tests.
			runner!.setPersistentRunnerActive(false);
			runner!.setPersistentRunnerActive(true);
		});

		afterEach(() => {
			delete process.env.PI_SUBAGENTS_STATE_DIR;
			removeTempDir(tempDir);
		});

		/** Mutable main-agent idle flag so tests can stream then settle. */
		function makeContext(idle: () => boolean): ExtensionContext {
			return {
				isIdle: idle,
				cwd: tempDir,
				sessionManager: { getSessionId: () => "runner-test-session" },
			} as unknown as ExtensionContext;
		}

		function makePi() {
			const sent: Array<{
				display: boolean;
				details: { state?: string; text?: string };
			}> = [];
			const pi = {
				sendMessage: (message: {
					display: boolean;
					details: { state?: string; text?: string };
				}) => {
					sent.push(message);
				},
			} as unknown as ExtensionAPI;
			return { pi, sent };
		}

		it("defers a routed prompt while the main agent streams", () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const { pi, sent } = makePi();
			const ctx = makeContext(() => false);

			runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);

			assert.equal(mockPi.callCount(), 0, "no child spawned while streaming");
			assert.deepEqual(sent, [], "no pending box rendered while streaming");
			assert.equal(store.getAgent(1)?.lastState, "idle");
		});

		it("keeps the idle-only guard for non-turn-boundary flushes", () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const { pi, sent } = makePi();
			const ctx = makeContext(() => false);

			runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);
			runner!.flushPendingRuns(pi, store, ctx, tempDir);

			assert.equal(mockPi.callCount(), 0, "no child spawned mid-run");
			assert.deepEqual(sent, []);
		});

		it("launches a deferred run at a turn boundary while the main agent streams", async () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const { pi, sent } = makePi();
			let idle = false;
			const ctx = makeContext(() => idle);
			mockPi.onCall({ output: "subagent done" });

			runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);
			assert.equal(mockPi.callCount(), 0, "still deferred before turn_end");

			// turn_end handler passes allowWhileStreaming, the steer-equivalent
			// boundary: the child launches even though the main agent is busy.
			runner!.flushPendingRuns(pi, store, ctx, tempDir, {
				allowWhileStreaming: true,
			});
			assert.equal(
				store.getAgent(1)?.lastState,
				"running",
				"run started at the turn boundary",
			);
			await waitFor(() => mockPi.callCount() === 1, "mock child spawned");
			// The box message is deferred: sending it while streaming would
			// steer an extra model turn.
			assert.deepEqual(sent, [] as { display: boolean; details: { state?: string; text?: string } }[], "no box message sent while streaming");

			// The main agent settles; the agent_settled flush drains the box.
			idle = true;
			runner!.flushPendingRuns(pi, store, ctx, tempDir);
			await waitFor(
				() => store.getAgent(1)?.lastState === "success",
				"run finalized",
			);
			assert.equal(sent.length, 2, "pending + final box messages sent");
			assert.equal(sent[0]!.display, true);
			assert.equal(sent[0]!.details.state, "pending");
			assert.equal(sent[1]!.display, false);
			assert.equal(sent[1]!.details.state, "success");
		});

		it("launches immediately and renders the box when the main agent is idle", async () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const { pi, sent } = makePi();
			const ctx = makeContext(() => true);
			mockPi.onCall({ output: "subagent done" });

			runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);

			assert.equal(sent.length, 1, "pending box rendered immediately");
			assert.equal(sent[0]!.display, true);
			assert.equal(sent[0]!.details.state, "pending");

			await waitFor(
				() => mockPi.callCount() === 1,
				"mock child spawned while idle",
			);
			await waitFor(
				() => store.getAgent(1)?.lastState === "success",
				"run finalized",
			);
			assert.equal(sent.length, 2, "final message sent after the child");
			assert.equal(sent[1]!.display, false);
			assert.equal(sent[1]!.details.state, "success");
		});

		it("streams live output into the store as the child works", async () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const { pi } = makePi();
			const ctx = makeContext(() => true);
			// The mock child emits two assistant messages in sequence before the
			// final output; each message_end triggers an onUpdate progress event.
			mockPi.onCall({
				steps: [
					{
						delay: 50,
						jsonl: [
							{
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: "first chunk" }],
									stopReason: "stop",
								},
							},
						],
					},
					{
						delay: 50,
						jsonl: [
							{
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: "second chunk" }],
									stopReason: "stop",
								},
							},
						],
					},
				],
			});

			runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);
			await waitFor(() => mockPi.callCount() === 1, "mock child spawned");
			// Live output appears before the run finalizes.
			await waitFor(
				() => (store.getAgent(1)?.lastOutput ?? "").includes("first chunk"),
				"live chunk one visible",
			);
			await waitFor(
				() => (store.getAgent(1)?.lastOutput ?? "").includes("second chunk"),
				"live chunk two visible",
			);
			await waitFor(
				() => store.getAgent(1)?.lastState === "success",
				"run finalized",
			);
			assert.match(store.getAgent(1)?.lastOutput ?? "", /second chunk/);
		});

		it("esc interrupt aborts a running child with the interrupted message", async () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const { pi } = makePi();
			const ctx = makeContext(() => true);
			// Long-running child: holds the slot while we interrupt it.
			mockPi.onCall({ output: "never reached", delay: 60_000 });

			runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);
			await waitFor(() => mockPi.callCount() === 1, "mock child spawned");
			assert.equal(
				runner!.interruptPersistentRun(1),
				true,
				"interrupt acknowledged",
			);
			await waitFor(
				() => store.getAgent(1)?.lastState === "fail",
				"interrupted run finalized as failure",
			);
			assert.match(
				store.getAgent(1)?.lastOutput ?? "",
				/Interrupted\. Waiting for explicit next action/,
			);
		});

		it("esc interrupt on an idle slot does nothing", () => {
			assert.equal(runner!.interruptPersistentRun(1), false);
		});

		it("cancels a queued prompt that has not launched yet", () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const { pi } = makePi();
			const ctx = makeContext(() => false);

			runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);
			assert.equal(mockPi.callCount(), 0, "still deferred");
			assert.equal(
				runner!.cancelQueuedPrompt(1),
				true,
				"queued prompt canceled",
			);
			// No launch even after the main agent settles.
			const idleCtx = makeContext(() => true);
			runner!.flushPendingRuns(pi, store, idleCtx, tempDir);
			assert.equal(mockPi.callCount(), 0, "canceled prompt never launches");
			assert.equal(
				runner!.cancelQueuedPrompt(1),
				false,
				"second cancel finds nothing",
			);
		});

		it("holds a session lease while a run is in flight and releases it after finalize", async () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const { pi } = makePi();
			const ctx = makeContext(() => true);
			mockPi.onCall({ output: "never reached", delay: 60_000 });

			runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);
			await waitFor(() => mockPi.callCount() === 1, "mock child spawned");
			const sessionFile = store.getAgent(1)?.sessionFile;
			assert.ok(sessionFile, "session file created by the run");
			assert.equal(
				inspectSessionLease(sessionFile).state,
				"owned",
				"lease held while the run is in flight",
			);

			runner!.interruptPersistentRun(1);
			await waitFor(
				() => store.getAgent(1)?.lastState === "fail",
				"interrupted run finalized",
			);
			assert.equal(
				inspectSessionLease(sessionFile).state,
				"free",
				"lease released after finalize",
			);
		});

		it("refuses a run when another process holds the session lease", async () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const sessionFile = path.join(tempDir, "persist-lease-block.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			store.setSessionFile(1, sessionFile);
			// A live lease held by another writer (e.g. a stale child from a
			// previous pi process that never released its session).
			const foreign = acquireSessionLease({
				sessionFile,
				runId: "foreign-run",
				sourceRunId: "foreign-run",
			});
			const { pi } = makePi();
			const ctx = makeContext(() => true);
			try {
				runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);
				await waitFor(
					() => store.getAgent(1)?.lastState === "fail",
					"run refused by the foreign lease",
				);
				assert.match(
					store.getAgent(1)?.lastOutput ?? "",
					/Another process still owns this channel's session/,
				);
				assert.equal(mockPi.callCount(), 0, "no child spawned");
			} finally {
				foreign.release();
			}
		});
	},
);

describe(
	"persistent runner /new channel reset",
	{ skip: !runner ? "pi packages not available" : undefined },
	() => {
		let tempDir: string;
		let mockPi: MockPi;

		before(() => {
			mockPi = createMockPi();
			mockPi.install();
		});

		after(() => {
			mockPi.uninstall();
		});

		beforeEach(() => {
			tempDir = createTempDir();
			mockPi.reset();
			process.env.PI_SUBAGENTS_STATE_DIR = tempDir;
			runner!.setPersistentRunnerActive(false);
			runner!.setPersistentRunnerActive(true);
		});

		afterEach(() => {
			delete process.env.PI_SUBAGENTS_STATE_DIR;
			removeTempDir(tempDir);
		});

		function makeContext(idle: () => boolean): ExtensionContext {
			return {
				isIdle: idle,
				cwd: tempDir,
				sessionManager: { getSessionId: () => "runner-test-session" },
			} as unknown as ExtensionContext;
		}

		function makePi() {
			const pi = {
				sendMessage: () => {},
			} as unknown as ExtensionAPI;
			return pi;
		}

		it("resets an idle channel: session file deleted, entry cleared, model kept", () => {
			const store = new PersistentChatStore();
			const sessionFile = path.join(tempDir, "persist-2.jsonl");
			fs.writeFileSync(sessionFile, "{}", "utf-8");
			store.setSessionFile(2, sessionFile);
			store.setRunState(2, "success");
			store.setRunOutput(2, "old output");
			store.setModel(2, "anthropic/claude-sonnet-4");

			runner!.resetChannelSession(
				store,
				makeContext(() => true),
				2,
			);

			const entry = store.getAgent(2);
			assert.ok(entry);
			assert.equal(entry.sessionFile, null);
			assert.equal(entry.lastState, "idle");
			assert.equal(entry.lastOutput, undefined);
			assert.equal(entry.model, "anthropic/claude-sonnet-4");
			assert.equal(fs.existsSync(sessionFile), false);
		});

		it("drops queued prompts for the channel on reset", () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const pi = makePi();
			const ctx = makeContext(() => false);

			runner!.enqueuePersistentPrompt(pi, store, ctx, "first", tempDir);
			runner!.enqueuePersistentPrompt(pi, store, ctx, "second", tempDir);
			assert.equal(mockPi.callCount(), 0, "still deferred");

			runner!.resetChannelSession(
				store,
				makeContext(() => true),
				1,
			);

			// Nothing launches after settling: the queued prompts were dropped.
			runner!.flushPendingRuns(
				pi,
				store,
				makeContext(() => true),
				tempDir,
			);
			assert.equal(mockPi.callCount(), 0, "no child spawned after reset");
		});

		it("busy /new interrupts the run and applies the reset after the child stops", async () => {
			const store = new PersistentChatStore();
			store.setTarget(1);
			const pi = makePi();
			const ctx = makeContext(() => true);
			mockPi.onCall({ output: "never reached", delay: 60_000 });

			runner!.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);
			await waitFor(() => mockPi.callCount() === 1, "mock child spawned");
			const sessionFile = store.getAgent(1)?.sessionFile;
			assert.ok(sessionFile, "session file created by the run");

			// /new while busy: interrupt now, reset deferred until the child dies.
			runner!.resetChannelSession(
				store,
				makeContext(() => true),
				1,
			);
			assert.equal(
				store.getAgent(1)?.sessionFile,
				sessionFile,
				"session file untouched while the child is still dying",
			);

			await waitFor(
				() => store.getAgent(1)?.sessionFile === null,
				"reset applied after the child stopped",
			);
			assert.equal(store.getAgent(1)?.lastState, "idle");
			assert.equal(
				fs.existsSync(sessionFile),
				false,
				"old session file deleted",
			);
		});
	},
);

describe(
	"persistent runner /clone",
	{ skip: !runner ? "pi packages not available" : undefined },
	() => {
		let tempDir: string;
		beforeEach(() => {
			tempDir = createTempDir();
			process.env.PI_SUBAGENTS_STATE_DIR = tempDir;
			runner!.setPersistentRunnerActive(false);
			runner!.setPersistentRunnerActive(true);
		});

		afterEach(() => {
			delete process.env.PI_SUBAGENTS_STATE_DIR;
			removeTempDir(tempDir);
		});

		/** A session manager whose fork produces a real copied session file. */
		function makeForkableContext(notifications: string[]): ExtensionContext {
			const parent = path.join(tempDir, "main-session.jsonl");
			fs.writeFileSync(
				parent,
				`${JSON.stringify({
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "main context" }],
					},
				})}\n`,
				"utf-8",
			);
			const forkDir = path.join(tempDir, "forks");
			fs.mkdirSync(forkDir, { recursive: true });
			return {
				isIdle: () => true,
				cwd: tempDir,
				hasUI: true,
				ui: {
					notify: (text: string) => {
						notifications.push(text);
					},
				},
				sessionManager: {
					getSessionId: () => "runner-test-session",
					getSessionFile: () => parent,
					getLeafId: () => "leaf-1",
					getSessionDir: () => forkDir,
					openSession: (file: string) => ({
						createBranchedSession: () => {
							const out = path.join(forkDir, "fork.jsonl");
							fs.copyFileSync(file, out);
							return out;
						},
					}),
				},
			} as unknown as ExtensionContext;
		}

		it("clones the main session into a fresh channel and stores the fork", () => {
			const store = new PersistentChatStore();
			const notifications: string[] = [];
			runner!.cloneMainSessionToChannel(
				store,
				makeForkableContext(notifications),
				1,
			);
			const sessionFile = store.getAgent(1)?.sessionFile;
			assert.ok(sessionFile, "forked session file stored");
			assert.ok(
				sessionFile.includes("forks"),
				"session file is the fork, not the parent",
			);
			assert.ok(fs.existsSync(sessionFile), "fork file exists on disk");
			assert.match(notifications.join(" "), /will start from a clone/);
		});

		it("refuses when the channel already has a session", () => {
			const store = new PersistentChatStore();
			store.setSessionFile(1, "/tmp/existing.jsonl");
			const notifications: string[] = [];
			runner!.cloneMainSessionToChannel(
				store,
				makeForkableContext(notifications),
				1,
			);
			assert.equal(
				store.getAgent(1)?.sessionFile,
				"/tmp/existing.jsonl",
				"existing session untouched",
			);
			assert.match(notifications.join(" "), /already has a session/);
		});

		it("warns when the main session cannot be forked (no persisted session)", () => {
			const store = new PersistentChatStore();
			const notifications: string[] = [];
			const ctx = {
				isIdle: () => true,
				cwd: tempDir,
				hasUI: true,
				ui: {
					notify: (text: string) => {
						notifications.push(text);
					},
				},
				sessionManager: {
					getSessionId: () => "runner-test-session",
					// No getSessionFile: the fork resolver reports no parent.
				},
			} as unknown as ExtensionContext;
			runner!.cloneMainSessionToChannel(store, ctx, 1);
			assert.equal(store.getAgent(1)?.sessionFile, null);
			assert.match(notifications.join(" "), /Cannot clone the main session/);
		});
	},
);
