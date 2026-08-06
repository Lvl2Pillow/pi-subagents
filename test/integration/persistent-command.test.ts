/**
 * Integration tests for runPersistentCommand: scoped slash commands
 * (/compact, /model, /name) dispatched against a persistent subagent.
 *
 * The command child is shimmed via PI_SUBAGENTS_COMMAND_BINARY so the
 * spawn/box/busy-guard lifecycle is exercised end-to-end without a real pi
 * process or LLM.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

interface RunnerModule {
	setPersistentRunnerActive: (value: boolean) => void;
	runPersistentCommand: (
		pi: ExtensionAPI,
		store: PersistentChatStore,
		ctx: ExtensionContext,
		entryIndex: number,
		command: "compact" | "model" | "name",
		args: string,
		extensionRoot: string,
	) => void;
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
}

const runner = await tryImport<RunnerModule>("./src/persistent/runner.ts");

const EXTENSION_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const COMMAND_SCRIPT_PATH = path.join(
	EXTENSION_ROOT,
	"scripts",
	"persist-command.mjs",
);

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

/**
 * Install a mock command binary. Writes its argv to `argvLog` and its cwd to
 * `cwdLog`, echoes `stdout`, and exits with `exitCode`.
 */
function installMockCommandBinary(options: {
	argvLog: string;
	cwdLog: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}): () => void {
	const previous = process.env.PI_SUBAGENTS_COMMAND_BINARY;
	const scriptPath = path.join(
		createTempDir("pi-command-mock-"),
		"mock-command.sh",
	);
	fs.writeFileSync(
		scriptPath,
		`#!/bin/sh
printf '%s\n' "$@" > "${options.argvLog}"
pwd > "${options.cwdLog}"
printf '%s' "${options.stdout ?? "COMMAND_OK"}"
if [ "${options.exitCode ?? 0}" != "0" ]; then
  printf '%s' "${options.stderr ?? "command failed"}" >&2
fi
exit ${options.exitCode ?? 0}
`,
		"utf-8",
	);
	fs.chmodSync(scriptPath, 0o755);
	process.env.PI_SUBAGENTS_COMMAND_BINARY = scriptPath;
	return () => {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_COMMAND_BINARY;
		else process.env.PI_SUBAGENTS_COMMAND_BINARY = previous;
		try {
			fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
		} catch {}
	};
}

describe(
	"persistent command dispatch",
	{ skip: !runner ? "pi packages not available" : undefined },
	() => {
		let tempDir: string;
		let mockPi: MockPi;
		let uninstallMockCommand: (() => void) | undefined;
		let argvLog: string;
		let cwdLog: string;

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
			argvLog = path.join(tempDir, "argv.log");
			cwdLog = path.join(tempDir, "cwd.log");
			uninstallMockCommand = installMockCommandBinary({ argvLog, cwdLog });
			runner!.setPersistentRunnerActive(false);
			runner!.setPersistentRunnerActive(true);
		});

		afterEach(() => {
			uninstallMockCommand?.();
			uninstallMockCommand = undefined;
			delete process.env.PI_SUBAGENTS_STATE_DIR;
			removeTempDir(tempDir);
		});

		function makeContext(idle = true): ExtensionContext {
			return {
				isIdle: () => idle,
				hasUI: false,
				cwd: tempDir,
				sessionManager: { getSessionId: () => "command-test-session" },
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

		function makeStoreWithSession(): PersistentChatStore {
			const store = new PersistentChatStore();
			// Channels pre-exist (no spawn); target channel 1 for routing.
			store.setTarget(1);
			store.setSessionFile(1, path.join(tempDir, "persist-1.jsonl"));
			return store;
		}

		it("spawns the command child with --session-file and the command", async () => {
			const store = makeStoreWithSession();
			const { pi, sent } = makePi();
			const ctx = makeContext();

			runner!.runPersistentCommand(pi, store, ctx, 1, "compact", "", tempDir);

			await waitFor(() => fs.existsSync(argvLog), "command child spawned");
			const args = fs.readFileSync(argvLog, "utf-8").trim().split("\n");
			assert.deepEqual(args, [
				"--session-file",
				path.join(tempDir, "persist-1.jsonl"),
				"compact",
			]);
			assert.equal(
				fs.realpathSync(fs.readFileSync(cwdLog, "utf-8").trim()),
				fs.realpathSync(tempDir),
			);

			await waitFor(
				() => store.getAgent(1)?.lastState === "success",
				"command finalized",
			);
			assert.equal(sent.length, 2, "pending + final box messages");
			assert.equal(sent[0].display, true);
			assert.equal(sent[0].details.state, "pending");
			assert.equal(sent[0].details.text, "/compact");
			assert.equal(sent[1].display, false);
			assert.equal(sent[1].details.state, "success");
			assert.match(sent[1].details.text ?? "", /COMMAND_OK/);
		});

		it("passes command args through as a single argv element", async () => {
			const store = makeStoreWithSession();
			const { pi } = makePi();
			const ctx = makeContext();

			runner!.runPersistentCommand(
				pi,
				store,
				ctx,
				1,
				"compact",
				"keep the plan",
				tempDir,
			);

			await waitFor(() => fs.existsSync(argvLog), "command child spawned");
			const args = fs.readFileSync(argvLog, "utf-8").trim().split("\n");
			assert.deepEqual(args.at(-1), "keep the plan");
		});

		it("reports failure with the child stderr as the box output", async () => {
			uninstallMockCommand?.();
			uninstallMockCommand = installMockCommandBinary({
				argvLog,
				cwdLog,
				stdout: "",
				stderr: "cannot compact: nothing to compact",
				exitCode: 1,
			});
			const store = makeStoreWithSession();
			const { pi, sent } = makePi();
			const ctx = makeContext();

			runner!.runPersistentCommand(pi, store, ctx, 1, "compact", "", tempDir);

			await waitFor(
				() => store.getAgent(1)?.lastState === "fail",
				"command failed",
			);
			assert.equal(sent.at(-1)?.details.state, "fail");
			assert.match(sent.at(-1)?.details.text ?? "", /nothing to compact/);
			assert.equal(
				store.getAgent(1)?.lastOutput,
				"cannot compact: nothing to compact",
			);
		});

		it("refuses a command while the slot is running a prompt", async () => {
			const store = makeStoreWithSession();
			const notifications: string[] = [];
			const ctx = {
				isIdle: () => true,
				hasUI: true,
				cwd: tempDir,
				sessionManager: { getSessionId: () => "s" },
				ui: { notify: (message: string) => notifications.push(message) },
			} as unknown as ExtensionContext;
			const { pi } = makePi();
			// Slow child so the slot stays busy while we assert the guard.
			mockPi.onCall({ output: "subagent done", delay: 1000 });

			// Occupy the slot with a prompt run (enqueued; launch at turn end).
			runner!.setPersistentRunnerActive(false);
			runner!.setPersistentRunnerActive(true);
			// Simulate a running prompt: enqueue + flush with allowWhileStreaming
			// so the mock pi child occupies runningSlots.
			const runnerFull =
				(await import("../../src/persistent/runner.ts")) as RunnerModule;
			runnerFull.enqueuePersistentPrompt(pi, store, ctx, "hello sub", tempDir);
			runnerFull.flushPendingRuns(pi, store, ctx, tempDir, {
				allowWhileStreaming: true,
			});
			await waitFor(() => mockPi.callCount() === 1, "prompt child spawned");

			// The command must be refused: the command child would race the run
			// child for the same session file.
			runnerFull.runPersistentCommand(
				pi,
				store,
				ctx,
				1,
				"compact",
				"",
				tempDir,
			);
			assert.equal(store.getAgent(1)?.lastState, "running");
			assert.ok(
				notifications.some((message) => /busy/.test(message)),
				"busy notification shown",
			);
			// Let the slow prompt child finish before teardown.
			await waitFor(
				() => store.getAgent(1)?.lastState === "success",
				"prompt run completed",
			);
		});

		it("stores a /model override even before a session exists", () => {
			const store = new PersistentChatStore();
			// Channels pre-exist (no spawn).
			const notifications: string[] = [];
			const ctx = {
				isIdle: () => true,
				hasUI: true,
				cwd: tempDir,
				sessionManager: { getSessionId: () => "s" },
				ui: { notify: (message: string) => notifications.push(message) },
			} as unknown as ExtensionContext;
			const { pi } = makePi();

			runner!.runPersistentCommand(
				pi,
				store,
				ctx,
				1,
				"model",
				"anthropic/claude-sonnet-4",
				tempDir,
			);

			assert.equal(store.getAgent(1)?.model, "anthropic/claude-sonnet-4");
			assert.ok(
				notifications.some((message) =>
					/applies on first prompt/.test(message),
				),
				"no-session notification shown",
			);
		});

		it("applies /model to an existing session via the command child", async () => {
			const store = makeStoreWithSession();
			const { pi, sent } = makePi();
			const ctx = makeContext();

			runner!.runPersistentCommand(
				pi,
				store,
				ctx,
				1,
				"model",
				"anthropic/claude-sonnet-4",
				tempDir,
			);

			await waitFor(() => fs.existsSync(argvLog), "command child spawned");
			const args = fs.readFileSync(argvLog, "utf-8").trim().split("\n");
			assert.deepEqual(args, [
				"--session-file",
				path.join(tempDir, "persist-1.jsonl"),
				"model",
				"anthropic/claude-sonnet-4",
			]);
			await waitFor(
				() => store.getAgent(1)?.lastState === "success",
				"model applied",
			);
			assert.equal(store.getAgent(1)?.model, "anthropic/claude-sonnet-4");
			assert.equal(sent.at(-1)?.details.state, "success");
		});

		it("notifies when compact/name target a subagent with no session yet", () => {
			const store = new PersistentChatStore();
			// Channels pre-exist (no spawn).
			const notifications: string[] = [];
			const ctx = {
				isIdle: () => true,
				hasUI: true,
				cwd: tempDir,
				sessionManager: { getSessionId: () => "s" },
				ui: { notify: (message: string) => notifications.push(message) },
			} as unknown as ExtensionContext;
			const { pi } = makePi();

			runner!.runPersistentCommand(pi, store, ctx, 1, "compact", "", tempDir);
			assert.ok(
				notifications.some((message) => /no session yet/.test(message)),
				"no-session notification shown for /compact",
			);
		});

		it("real command child renames a subagent session on disk", async () => {
			// Hand-crafted session file (session header + user + assistant) so the
			// script's SessionManager loads it flushed and appends the rename.
			const sessionDir = createTempDir("pi-command-session-");
			const sessionFile = path.join(sessionDir, "persist-1.jsonl");
			const now = new Date().toISOString();
			const entries = [
				{
					type: "session",
					version: 3,
					id: "real-script-test-session",
					timestamp: now,
					cwd: tempDir,
				},
				{
					type: "message",
					id: "m1",
					parentId: "real-script-test-session",
					timestamp: now,
					message: {
						role: "user",
						content: [{ type: "text", text: "hello sub" }],
					},
				},
				{
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: now,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hi there" }],
					},
				},
			];
			fs.writeFileSync(
				sessionFile,
				entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
				"utf-8",
			);

			const agentDir = createTempDir("pi-command-agent-");
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agentDir;
			try {
				const child = spawn(
					process.execPath,
					[
						COMMAND_SCRIPT_PATH,
						"--session-file",
						sessionFile,
						"name",
						"renamed sub",
					],
					{ cwd: tempDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
				);
				let stdout = "";
				let stderr = "";
				child.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				const exitCode: number | null = await new Promise((resolve) => {
					child.on("close", resolve);
				});
				assert.equal(
					exitCode,
					0,
					`command child exited ${exitCode}: ${stderr}`,
				);
				assert.match(stdout, /renamed to "renamed sub"/);

				// The session_info rename landed in the session file (loaded flushed,
				// so appends go straight to disk).
				const fileText = fs.readFileSync(sessionFile, "utf-8");
				assert.ok(fileText.includes('"renamed sub"'), "rename persisted");
				assert.ok(
					fileText.includes('"type":"session_info"'),
					"session_info entry",
				);
			} finally {
				if (previousAgentDir === undefined)
					delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				removeTempDir(sessionDir);
				removeTempDir(agentDir);
			}
		});
	},
);
