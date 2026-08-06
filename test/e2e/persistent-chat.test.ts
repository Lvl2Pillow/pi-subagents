/**
 * Real Pi-session end-to-end test for the permanent-channels persistent chat.
 *
 * Persistent state is scoped per MAIN-AGENT SESSION: state and channel
 * session files live under `<STATE_DIR>/sessions/<sessionId>/`. A brand-new
 * pi session (new id) must start with clean channels and never see another
 * session's subagents; continuing/resuming the same id restores them.
 *
 * Drives a real parent `AgentSession` (faux provider) through the extension's
 * actual wiring. All channels exist from startup (configurable slotCount,
 * default 3); a channel gets a session file only after its first routed
 * prompt. Routing uses the registered alt+n shortcut handler (the harness
 * cannot inject raw keys).
 *
 * Skips gracefully when the pi runtime packages are not importable.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { tryImport } from "../support/helpers.ts";
import type { RealSessionRun } from "../support/real-session-runner.ts";

const piCodingAgent = await tryImport<unknown>(
	"@earendil-works/pi-coding-agent",
);
const piAi = await tryImport<unknown>("@earendil-works/pi-ai");
const available = Boolean(piCodingAgent && piAi);

const __filename = fileURLToPath(import.meta.url);
const TEST_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const STATE_DIR = path.join(TEST_ROOT, ".tmp-e2e-state-persistent-chat");
const STATE_DIR_ENV = "PI_SUBAGENTS_STATE_DIR";

// Fixed main-session ids (valid per pi's assertValidSessionId). Distinct
// ids prove leak isolation; a shared id proves restart survival.
const SESSION_A = "e2echana0a1";
const SESSION_B = "e2echana0b2";

interface SessionMessage {
	role?: string;
	customType?: string;
	display?: boolean;
	details?: unknown;
	content?: unknown;
}

function runMessages(run: RealSessionRun): SessionMessage[] {
	const messages = run.parentSession.messages as SessionMessage[];
	return messages.filter(
		(message) =>
			message.role === "custom" && message.customType === "persist.run",
	);
}

/** Session-scoped state root for a fixed session id. */
function sessionRoot(sessionId: string): string {
	return path.join(STATE_DIR, "sessions", sessionId);
}

/** The registered alt+n shortcut handler (target cycle main → 1 → … → main). */
function altNShortcut(session: RealSessionRun["parentSession"]) {
	const shortcuts = (
		session as never as {
			extensionRunner: {
				getShortcuts(
					opts: never,
				): Map<string, { handler: (ctx: unknown) => Promise<void> | void }>;
			};
		}
	).extensionRunner.getShortcuts({} as never);
	return shortcuts.get("alt+n");
}

describe(
	"persistent-chat permanent channels E2E",
	{ skip: !available ? "pi runtime packages not available" : undefined },
	() => {
		let run: RealSessionRun | undefined;

		const previousStateDir = process.env[STATE_DIR_ENV];

		before(() => {
			fs.rmSync(STATE_DIR, { recursive: true, force: true });
		});

		beforeEach(() => {
			fs.rmSync(STATE_DIR, { recursive: true, force: true });
			fs.mkdirSync(STATE_DIR, { recursive: true });
			process.env[STATE_DIR_ENV] = STATE_DIR;
		});

		afterEach(async () => {
			await run?.dispose();
			run = undefined;
			fs.rmSync(STATE_DIR, { recursive: true, force: true });
			if (previousStateDir === undefined) delete process.env[STATE_DIR_ENV];
			else process.env[STATE_DIR_ENV] = previousStateDir;
		});

		it("boots with permanent channels: main prompts work, no children spawned, no state/session files written", async () => {
			const { runRealSubagentSession } =
				await import("../support/real-session-runner.ts");
			run = await runRealSubagentSession({
				prompt: "hello main",
				childText: "persistent-e2e-child",
				sessionId: SESSION_A,
				respond: () => "parent ok",
			});

			// Only the main prompt reached the model; nothing routed to a channel.
			assert.equal(run.modelCalls, 1);
			assert.equal(runMessages(run).length, 0);
			// Channels exist implicitly from startup; no prompt has spawned a
			// session yet, so no channel state may be written for this session.
			// (A session-scoped debug log is fine; channel state is not.)
			assert.equal(
				fs.existsSync(
					path.join(sessionRoot(SESSION_A), "persistent-state.json"),
				),
				false,
				"no state file until the first channel mutation",
			);
			assert.equal(
				fs.existsSync(path.join(sessionRoot(SESSION_A), "persistent-sessions")),
				false,
				"no session files until a routed prompt",
			);
		});

		it("isolates persistent state to PI_SUBAGENTS_STATE_DIR and never touches the extension root", async () => {
			const { runRealSubagentSession } =
				await import("../support/real-session-runner.ts");

			// Snapshot the real extension root before the run so the assertion
			// below proves THIS run wrote nothing there — even when the user's
			// own persistent state files already exist at the root.
			const rootStateFile = path.join(TEST_ROOT, "persistent-state.json");
			const rootSessionsDir = path.join(TEST_ROOT, "persistent-sessions");
			const rootScopedDir = path.join(TEST_ROOT, "sessions");
			const rootLogsDir = path.join(TEST_ROOT, "logs");
			const rootBefore = {
				state: fs.existsSync(rootStateFile),
				sessions: fs.existsSync(rootSessionsDir),
				scoped: fs.existsSync(rootScopedDir),
				logs: fs.existsSync(rootLogsDir),
			};

			run = await runRealSubagentSession({
				prompt: "hello main",
				childText: "ISOLATED_STATE_CHILD",
				sessionId: SESSION_B,
				respond: () => "parent ok",
			});

			// The test run must not have created or modified anything at the
			// real extension root (the state root used when no env override).
			assert.equal(
				fs.existsSync(rootStateFile),
				rootBefore.state,
				"extension root persistent-state.json unchanged by test run",
			);
			assert.equal(
				fs.existsSync(rootSessionsDir),
				rootBefore.sessions,
				"extension root persistent-sessions/ unchanged by test run",
			);
			assert.equal(
				fs.existsSync(rootScopedDir),
				rootBefore.scoped,
				"extension root sessions/ unchanged by test run",
			);
			assert.equal(
				fs.existsSync(rootLogsDir),
				rootBefore.logs,
				"extension root logs/ unchanged by test run",
			);
		});

		it("startup restore does not rewrite the state file or touch session files", async () => {
			const { runRealSubagentSession } =
				await import("../support/real-session-runner.ts");

			// Pre-seed a v2 state file (3 channels) + one real session file in
			// session A's scope, as a restarted pi would have left behind. The
			// extension must load it without writing anything back (restore
			// runs at session bind without mutating a loaded store) and
			// without spawning any child.
			const root = sessionRoot(SESSION_A);
			const sessionsDir = path.join(root, "persistent-sessions");
			fs.mkdirSync(sessionsDir, { recursive: true });
			const stateFile = path.join(root, "persistent-state.json");
			const sessionFile = path.join(sessionsDir, "persist-1.jsonl");
			const sessionText =
				'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"seeded prompt"}]}}\n' +
				'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"seeded output"}]}}\n';
			fs.writeFileSync(sessionFile, sessionText, "utf-8");
			const state = {
				version: 2,
				entries: [
					{ id: "persist-1", sessionFile },
					{ id: "persist-2", sessionFile: null },
					{ id: "persist-3", sessionFile: null },
				],
				targetIndex: 0,
			};
			fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
			const stateBefore = fs.readFileSync(stateFile, "utf-8");

			run = await runRealSubagentSession({
				prompt: "hello main",
				childText: "RESTORE_E2E_CHILD",
				sessionId: SESSION_A,
				respond: () => "parent ok",
			});

			assert.equal(run.modelCalls, 1);
			assert.equal(runMessages(run).length, 0, "no persistent run happened");
			assert.equal(
				fs.readFileSync(stateFile, "utf-8"),
				stateBefore,
				"startup restore must not rewrite the state file",
			);
			assert.equal(
				fs.readFileSync(sessionFile, "utf-8"),
				sessionText,
				"session file untouched by startup",
			);
		});

		it("a brand-new pi session never sees another session's subagents (leak isolation)", async () => {
			const { runRealSubagentSession, waitForPersistentRuns } =
				await import("../support/real-session-runner.ts");

			// Session A: route one prompt to channel 1 so it writes a real
			// session file + state file inside A's scope.
			run = await runRealSubagentSession({
				prompt: "hello main",
				childText: "LEAK_SESSION_A_CHILD",
				sessionId: SESSION_A,
				respond: () => "parent ok",
			});
			const altN = altNShortcut(run.parentSession);
			assert.ok(altN, "alt+n shortcut registered");
			await altN.handler({ hasUI: false });
			await run.parentSession.prompt("hello sub");
			await waitForPersistentRuns(run.parentSession, {
				expectedCompletions: 1,
			});
			await run.dispose();
			run = undefined;
			assert.ok(
				fs.existsSync(
					path.join(sessionRoot(SESSION_A), "persistent-state.json"),
				),
				"session A wrote its state file",
			);

			// Session B: a brand-new session id. Its scope must not exist —
			// no channels, no state, nothing carried over from A.
			run = await runRealSubagentSession({
				prompt: "hello main",
				childText: "LEAK_SESSION_B_CHILD",
				sessionId: SESSION_B,
				respond: () => "parent ok",
			});
			assert.equal(run.modelCalls, 1, "main prompt handled normally");
			assert.equal(
				runMessages(run).length,
				0,
				"no persist.run messages in the new session",
			);
			// No channel state may exist in B's scope (a scoped debug log is
			// expected; channel state is not).
			assert.equal(
				fs.existsSync(
					path.join(sessionRoot(SESSION_B), "persistent-state.json"),
				),
				false,
				"no state file: nothing leaked from session A",
			);
			assert.equal(
				fs.existsSync(path.join(sessionRoot(SESSION_B), "persistent-sessions")),
				false,
				"no channel session files leaked from session A",
			);
		});

		it("restart survival: a new pi run with the same session id restores its channels", async () => {
			const { runRealSubagentSession, waitForPersistentRuns } =
				await import("../support/real-session-runner.ts");

			// First run (session A): route one prompt to channel 1.
			run = await runRealSubagentSession({
				prompt: "hello main",
				childText: "RESTART_A_CHILD",
				sessionId: SESSION_A,
				respond: () => "parent ok",
			});
			const altN = altNShortcut(run.parentSession);
			assert.ok(altN, "alt+n shortcut registered");
			await altN.handler({ hasUI: false });
			await run.parentSession.prompt("hello sub");
			await waitForPersistentRuns(run.parentSession, {
				expectedCompletions: 1,
			});
			await run.dispose();
			run = undefined;

			// Second run: SAME session id — the channel session + state must
			// be restored (files still on disk, no error, main works).
			const root = sessionRoot(SESSION_A);
			assert.ok(
				fs.existsSync(
					path.join(root, "persistent-sessions", "persist-1.jsonl"),
				),
				"channel session file persists on disk",
			);
			run = await runRealSubagentSession({
				prompt: "hello main",
				childText: "RESTART_B_CHILD",
				sessionId: SESSION_A,
				respond: () => "parent ok",
			});
			assert.equal(run.modelCalls, 1);
			// The restored scope is untouched by a boot that only prompts main:
			assert.ok(
				fs.existsSync(path.join(root, "persistent-state.json")),
				"state file still present after restart",
			);
			assert.equal(
				runMessages(run).length,
				0,
				"no new run: main prompt did not route to the restored channel",
			);
		});
	},
);
