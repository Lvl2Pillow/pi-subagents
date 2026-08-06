/**
 * Persistent-subagent runner: lazy session creation + background child runs.
 *
 * Every channel starts with no session; the session file is created at the
 * FIRST routed prompt under the extension's `persistent-sessions/` dir
 * (stable per index, survives restarts). The channel's first-prompt session
 * can instead be a fork of the main-agent session via /clone (only while
 * `sessionFile` is still null).
 *
 * Execution model (never blocks the main agent):
 *  - Routed prompts are enqueued, and runs only START at an agent-turn
 *    boundary (a model turn completed) — same spirit as pi's steering,
 *    which waits for the current turn instead of interrupting it. A prompt
 *    routed while the main agent is streaming is deferred until the next
 *    `turn_end` (the exact point where pi injects steering messages), not
 *    until the whole task finishes (`agent_settled`). The launch is safe
 *    mid-run: the child is a separate process and never touches the main
 *    agent's turn loop.
 *  - The child runs in the background via `runSync` (fire-and-forget): the
 *    main agent keeps working and keeps accepting input. Only one run per
 *    subagent slot runs at a time; extra prompts queue in order.
 *  - The child is spawned through the battle-tested `runSync` pipeline with
 *    the synthetic persistent AgentConfig, so the child is a real pi session
 *    that inherits all main-agent skills/extensions/tools — and keeps the
 *    sandbox extension active (no --no-extensions, no tool restriction).
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runSync } from "../runs/foreground/execution.ts";
import { createForkContextResolver } from "../shared/fork-context.ts";
import { buildPersistentSpawnAgent, persistentSessionFile } from "./spawn.ts";
import {
	PERSISTENT_RUN_TYPE,
	buildPersistentRunDetails,
	setPersistentRunLive,
	setPersistentRunState,
} from "./run-message.ts";
import type { PersistentAgentEntry, PersistentChatStore } from "./store.ts";
import { PERSISTENT_STATUS_KEY, buildPersistentStatus } from "./status.ts";
import type { AgentProgress } from "../shared/types.ts";
import { logPersistent, truncateText } from "./log.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** The command child that executes scoped commands against a subagent session. */
const COMMAND_SCRIPT_PATH = join(
	__dirname,
	"..",
	"..",
	"scripts",
	"persist-command.mjs",
);

/** Env override for tests: a binary that stands in for `node persist-command.mjs`. */
export const PERSISTENT_COMMAND_BINARY_ENV = "PI_SUBAGENTS_COMMAND_BINARY";

/** A routed prompt waiting for its slot to be free AND the main agent idle. */
interface QueuedPrompt {
	entryIndex: number;
	text: string;
}

const queuedPrompts: QueuedPrompt[] = [];
const runningSlots = new Set<number>();

/** Per-slot AbortController for Esc-to-interrupt (mirrors main's Esc abort). */
const interruptControllers = new Map<number, AbortController>();

/** In-flight scoped-command children, tracked so Esc//new can stop them too. */
const commandChildren = new Map<number, ChildProcess>();

/**
 * Channels waiting for their current run/command child to stop before the
 * /new reset is applied. The reset touches the session file, so it must wait
 * until the child is dead — never truncate a file a live child is writing.
 */
const pendingChannelResets = new Set<number>();

/**
 * Custom-message sends (pending box / final record) waiting for the main
 * agent to be idle. pi.sendMessage while the main agent is streaming routes
 * the message into the steering queue, which forces an extra model turn — so
 * box messages are deferred to the next idle moment (agent_settled) instead.
 * Child LAUNCHES never wait for idle: they happen at the turn boundary.
 */
interface DeferredMessageSend {
	kind: "pending" | "final";
	requestId: string;
	entryIndex: number;
	text: string;
	state?: "success" | "fail";
}

const deferredSends: DeferredMessageSend[] = [];

/**
 * Cleared on session shutdown so in-flight background runs finalize as
 * no-ops instead of touching an invalidated extension ctx (which throws
 * "This extension ctx is stale..."). The queue is also dropped.
 */
let active = true;

export function setPersistentRunnerActive(value: boolean): void {
	active = value;
	if (!value) {
		queuedPrompts.length = 0;
		runningSlots.clear();
		for (const controller of interruptControllers.values()) {
			controller.abort();
		}
		interruptControllers.clear();
		for (const child of commandChildren.values()) {
			try {
				child.kill("SIGINT");
			} catch {
				// Best-effort.
			}
		}
		commandChildren.clear();
		pendingChannelResets.clear();
		deferredSends.length = 0;
	}
}

/**
 * Abort the currently running child for a slot (Esc on an empty editor while
 * input targets that subagent, or /new while busy). Returns whether a run was
 * interrupted. The child's interruptSignal fires SIGINT, mirroring main's
 * "Interrupted." flow; a command child is killed with SIGINT directly.
 */
export function interruptPersistentRun(entryIndex: number): boolean {
	const controller = interruptControllers.get(entryIndex);
	if (controller) {
		controller.abort();
		return true;
	}
	const child = commandChildren.get(entryIndex);
	if (child && child.exitCode === null) {
		try {
			child.kill("SIGINT");
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Reset a channel (/new): drop its queued prompts, stop the current run if
 * one is in flight, and clear the session. When a child is running, the
 * session file is only touched AFTER the child stops (pendingChannelResets
 * fires from the run/command finalize path) so a dying child can never write
 * into a truncated file.
 */
export function resetChannelSession(
	store: PersistentChatStore,
	ctx: ExtensionContext,
	entryIndex: number,
): void {
	const entry = store.getAgent(entryIndex);
	if (!entry) return;
	logPersistent("run", "reset", {
		index: entryIndex,
		hadSession: entry.sessionFile !== null,
		running: runningSlots.has(entryIndex) || commandChildren.has(entryIndex),
	});
	while (cancelQueuedPrompt(entryIndex)) {
		// Drop every queued prompt for this channel.
	}
	if (runningSlots.has(entryIndex) || commandChildren.has(entryIndex)) {
		pendingChannelResets.add(entryIndex);
		interruptPersistentRun(entryIndex);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Subagent ${entryIndex} reset — a new session starts once the current run stops.`,
				"info",
			);
		}
		return;
	}
	applyChannelReset(store, entryIndex);
	if (ctx.hasUI) {
		ctx.ui.notify(
			`Subagent ${entryIndex} reset — the first prompt starts a fresh session.`,
			"info",
		);
	}
}

/** Delete the channel's session file (if any) and reset the store entry. */
function applyChannelReset(
	store: PersistentChatStore,
	entryIndex: number,
): void {
	const entry = store.getAgent(entryIndex);
	const file = entry?.sessionFile;
	if (file) {
		try {
			rmSync(file, { force: true });
		} catch {
			// Best-effort: a missing/locked file must not break the reset.
		}
	}
	store.resetChannel(entryIndex);
}

/**
 * Clone the main-agent session into a channel (/clone). Only allowed before
 * the channel's first prompt (sessionFile still null); /new re-allows it.
 * The fork happens at /clone time — a snapshot of main's session at that
 * point, which becomes the channel's starting conversation.
 */
export function cloneMainSessionToChannel(
	store: PersistentChatStore,
	ctx: ExtensionContext,
	entryIndex: number,
): void {
	const entry = store.getAgent(entryIndex);
	if (!entry) return;
	if (entry.sessionFile) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Subagent ${entryIndex} already has a session — /new first, then /clone.`,
				"warning",
			);
		}
		return;
	}
	let forked: string;
	try {
		const resolver = createForkContextResolver(ctx.sessionManager, "fork", {
			openSession: undefined,
		});
		const file = resolver.sessionFileForIndex(0);
		if (!file) throw new Error("No forked session file was produced.");
		forked = file;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) {
			ctx.ui.notify(`Cannot clone the main session: ${message}`, "warning");
		}
		return;
	}
	store.setSessionFile(entryIndex, forked);
	if (ctx.hasUI) {
		ctx.ui.notify(
			`Subagent ${entryIndex} will start from a clone of the main session.`,
			"info",
		);
	}
}

/** Remove a queued (not yet launched) prompt for a slot. Returns whether one existed. */
export function cancelQueuedPrompt(entryIndex: number): boolean {
	const index = queuedPrompts.findIndex(
		(prompt) => prompt.entryIndex === entryIndex,
	);
	if (index === -1) return false;
	queuedPrompts.splice(index, 1);
	return true;
}

/**
 * Compose the live text shown while a subagent run is in progress: the
 * current tool (with its args), the tail of recent output, and a running
 * tool/token counter. Falls back to the streamed content text.
 */
export function formatLiveProgress(
	progress: AgentProgress | undefined,
	fallback: string,
): string {
	if (!progress) return fallback || "(running...)";
	const parts: string[] = [];
	if (progress.currentTool) {
		const args = progress.currentToolArgs?.trim();
		parts.push(`⚙ ${progress.currentTool}${args ? ` — ${args}` : ""}`);
	}
	const tail = (progress.recentOutput ?? []).slice(-12);
	if (tail.length > 0) parts.push(...tail);
	if (progress.toolCount || progress.tokens) {
		parts.push(
			`(${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"}, ${progress.tokens} tokens)`,
		);
	}
	return parts.join("\n") || fallback || "(running...)";
}

/** True when the main agent is idle (safe to launch a background run). */
function mainIsIdle(ctx: ExtensionContext): boolean {
	try {
		return ctx.isIdle();
	} catch {
		// Stale/invalidated ctx (e.g. after reload): defer the launch.
		return false;
	}
}

/**
 * Resolve the session file for an entry, creating it lazily on the first
 * routed prompt. Persists the resolved path through the store so later
 * prompts resume the same session (even across restarts). A channel whose
 * session was cloned via /clone already has `sessionFile` set and resumes
 * the fork.
 */
export function ensureSessionFile(
	store: PersistentChatStore,
	entry: PersistentAgentEntry,
	extensionRoot: string,
): string {
	if (entry.sessionFile) return entry.sessionFile;
	const sessionFile = persistentSessionFile(extensionRoot, entry.index);
	store.setSessionFile(entry.index, sessionFile);
	return sessionFile;
}

/**
 * Route a user prompt to the currently targeted persistent subagent. The
 * prompt is queued and the subagent run starts in the background once the
 * main agent is idle and the slot is free. Never blocks the main agent.
 */
export function enqueuePersistentPrompt(
	pi: ExtensionAPI,
	store: PersistentChatStore,
	ctx: ExtensionContext,
	text: string,
	extensionRoot: string,
): void {
	const entryIndex = store.getTarget();
	const entry = store.getAgent(entryIndex);
	if (!entry) return;
	queuedPrompts.push({ entryIndex, text });
	logPersistent("run", "queued", {
		index: entryIndex,
		text: truncateText(text),
		mainIdle: mainIsIdle(ctx),
	});
	flushPendingRuns(pi, store, ctx, extensionRoot);
}

/**
 * Send deferred box messages once the main agent is idle. No-op while the
 * main agent is streaming (sending then would steer an extra model turn).
 */
export function drainDeferredMessageSends(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	if (!active || !mainIsIdle(ctx)) return;
	for (let i = 0; i < deferredSends.length; i++) {
		const send = deferredSends[i];
		if (send.kind === "pending") {
			pi.sendMessage(
				{
					customType: PERSISTENT_RUN_TYPE,
					content: "",
					display: true,
					details: buildPersistentRunDetails(
						send.requestId,
						send.entryIndex,
						send.text,
					),
				},
				{ triggerTurn: false },
			);
		} else {
			pi.sendMessage(
				{
					customType: PERSISTENT_RUN_TYPE,
					content: "",
					display: false,
					details: {
						requestId: send.requestId,
						agentIndex: send.entryIndex,
						state: send.state ?? "success",
						text: send.text,
					},
				},
				{ triggerTurn: false },
			);
		}
		deferredSends.splice(i, 1);
		i--;
	}
}

/**
 * Launch queued runs whose slot is free. By default this only launches while
 * the main agent is idle (call sites: input handler, after a run finishes,
 * `agent_settled` safety net). Pass `allowWhileStreaming: true` at a turn
 * boundary (`turn_end`) so a deferred prompt starts right after the current
 * model turn completes — the steer-equivalent moment — even though the main
 * agent may continue with more turns.
 */
export function flushPendingRuns(
	pi: ExtensionAPI,
	store: PersistentChatStore,
	ctx: ExtensionContext,
	extensionRoot: string,
	options?: { allowWhileStreaming?: boolean },
): void {
	if (!options?.allowWhileStreaming && !mainIsIdle(ctx)) return;
	drainDeferredMessageSends(pi, ctx);
	for (let i = 0; i < queuedPrompts.length; i++) {
		const item = queuedPrompts[i];
		if (runningSlots.has(item.entryIndex)) continue;
		const entry = store.getAgent(item.entryIndex);
		if (!entry) continue;
		queuedPrompts.splice(i, 1);
		i--;
		// Fire-and-forget: never await the child here, so the main agent is
		// never blocked on a subagent run.
		void launchRun(pi, store, ctx, entry, item.text, extensionRoot);
	}
}

/** Run one subagent prompt in the background and finalize its message box. */
async function launchRun(
	pi: ExtensionAPI,
	store: PersistentChatStore,
	ctx: ExtensionContext,
	entry: PersistentAgentEntry,
	text: string,
	extensionRoot: string,
): Promise<void> {
	const requestId = randomUUID();
	logPersistent("run", "start", {
		requestId,
		index: entry.index,
		text: truncateText(text),
	});
	store.setRunState(entry.index, "running");
	runningSlots.add(entry.index);
	const interrupt = new AbortController();
	interruptControllers.set(entry.index, interrupt);
	// The pending box is sent when the main agent is idle (immediately for an
	// idle launch, else at the next agent_settled). While the main agent is
	// streaming, sendMessage would queue the box as a steer and force an extra
	// model turn, so it is deferred instead of sent here.
	deferredSends.push({
		kind: "pending",
		requestId,
		entryIndex: entry.index,
		text,
	});
	drainDeferredMessageSends(pi, ctx);

	const finalizeFail = (error: unknown): void => {
		if (!active) return;
		const message = error instanceof Error ? error.message : String(error);
		logPersistent("run", "failed", {
			requestId,
			index: entry.index,
			error: truncateText(message),
		});
		setPersistentRunState(requestId, "fail", message, entry.index);
		store.setRunState(entry.index, "fail");
		store.setRunOutput(entry.index, message);
		deferredSends.push({
			kind: "final",
			requestId,
			entryIndex: entry.index,
			state: "fail",
			text: message,
		});
		drainDeferredMessageSends(pi, ctx);
	};

	try {
		let sessionFile: string;
		try {
			sessionFile = ensureSessionFile(store, entry, extensionRoot);
			logPersistent("run", "session ready", {
				requestId,
				index: entry.index,
				sessionFile,
			});
		} catch (error) {
			finalizeFail(error);
			return;
		}

		const agent = buildPersistentSpawnAgent();
		const startedAt = Date.now();
		// Live streaming: every child progress event (assistant message, tool
		// start/end) updates the pending box snapshot AND the fleet's "Last
		// output:" row. The status-tickle forces a TUI re-render (throttled) so
		// the chat message visibly streams instead of jumping to the final text.
		let lastTickleAt = 0;
		const tickleRender = (): void => {
			if (!ctx.hasUI) return;
			const now = Date.now();
			if (now - lastTickleAt < 250) return;
			lastTickleAt = now;
			try {
				ctx.ui.setStatus(
					PERSISTENT_STATUS_KEY,
					buildPersistentStatus(store.getTarget()),
				);
			} catch {
				// Stale/invalidated ctx: stop tickling.
			}
		};
		const result = await runSync(ctx.cwd, [agent], "persistent", text, {
			runId: requestId,
			parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
			cwd: ctx.cwd,
			sessionFile,
			sessionDir: dirname(sessionFile),
			...(entry.model ? { modelOverride: entry.model } : {}),
			acceptance: false,
			interruptSignal: interrupt.signal,
			onUpdate: (update) => {
				if (!active) return;
				const progress = update.details?.progress?.[0];
				const firstContent = update.content?.[0] as
					{ text?: string } | undefined;
				const live = formatLiveProgress(progress, firstContent?.text ?? "");
				setPersistentRunLive(requestId, live);
				store.setRunOutput(entry.index, live);
				tickleRender();
			},
		});
		// An interrupted run is a failure (red box) even though the child exits 0
		// with a clean "Interrupted." final output — the user asked for it to
		// stop, not for a completed result.
		const ok = result.exitCode === 0 && !result.error && !result.interrupted;
		logPersistent("run", "child finished", {
			requestId,
			index: entry.index,
			ok,
			exitCode: result.exitCode,
			interrupted: result.interrupted === true,
			durationMs: Date.now() - startedAt,
			error: result.error ? truncateText(result.error) : undefined,
		});
		if (!active) return;
		const output = ok
			? (result.finalOutput ?? "")
			: (result.error ??
				(result.interrupted
					? (result.finalOutput ??
						"Interrupted. Waiting for explicit next action.")
					: `Persistent subagent failed (exit ${result.exitCode}).`));
		setPersistentRunState(
			requestId,
			ok ? "success" : "fail",
			output,
			entry.index,
		);
		store.setRunState(entry.index, ok ? "success" : "fail");
		store.setRunOutput(entry.index, output);
		// Persist the final state as a second (non-displayed) message so the
		// outcome survives restarts and is observable from the session entries.
		// The visible pending message transitions in place via the live snapshot
		// (and renders with the final state if it was deferred past completion).
		deferredSends.push({
			kind: "final",
			requestId,
			entryIndex: entry.index,
			state: ok ? "success" : "fail",
			text: output,
		});
		drainDeferredMessageSends(pi, ctx);
	} catch (error) {
		finalizeFail(error);
	} finally {
		interruptControllers.delete(entry.index);
		runningSlots.delete(entry.index);
		// A /new requested while this run was in flight: the child is dead now,
		// so it is safe to clear the session file.
		if (pendingChannelResets.delete(entry.index)) {
			applyChannelReset(store, entry.index);
		}
		// The slot is free again: start the next queued prompt for it if the
		// main agent is idle. The ctx may be stale after a reload; flush is
		// defensive and simply defers in that case.
		try {
			flushPendingRuns(pi, store, ctx, extensionRoot);
		} catch {
			// Best-effort drain; never let cleanup throw.
		}
	}
}

// ============================================================================
// Scoped slash commands (/compact, /model, /name against the active subagent)
// ============================================================================

/** How the command binary is spawned (env override for tests). */
function resolveCommandSpawn(args: string[]): {
	command: string;
	args: string[];
} {
	const override = process.env[PERSISTENT_COMMAND_BINARY_ENV]?.trim();
	if (override) return { command: override, args };
	return { command: process.execPath, args: [COMMAND_SCRIPT_PATH, ...args] };
}

/**
 * Run a scoped slash command against the active subagent's session, in the
 * background (never blocks the main agent). A busy slot (a routed prompt run
 * is in flight) refuses the command with a notify — the command child would
 * otherwise race the run child for the same session file.
 *
 * `model` is special: the override is stored immediately (so it applies to
 * the first prompt even before a session exists); when a session already
 * exists it is also applied in the child so the session file records it.
 */
export function runPersistentCommand(
	pi: ExtensionAPI,
	store: PersistentChatStore,
	ctx: ExtensionContext,
	entryIndex: number,
	command: "compact" | "model" | "name",
	args: string,
	extensionRoot: string,
): void {
	const entry = store.getAgent(entryIndex);
	if (!entry) {
		if (ctx.hasUI) {
			ctx.ui.notify(`No persistent subagent in slot ${entryIndex}.`, "warning");
		}
		return;
	}
	logPersistent("command", "dispatch", {
		index: entryIndex,
		command,
		args: truncateText(args),
	});
	if (command === "model") {
		const modelArg = args.trim();
		if (!modelArg) {
			// Bare /model is handled by the caller (model picker overlay).
			return;
		}
		// Validated by the caller against ctx.modelRegistry; store now so the
		// override applies to the first prompt even without a session.
		store.setModel(entryIndex, modelArg);
		if (!entry.sessionFile) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Subagent ${entryIndex} model set to ${modelArg} (applies on first prompt).`,
					"info",
				);
			}
			return;
		}
	}
	if (runningSlots.has(entryIndex)) {
		if (ctx.hasUI) {
			if (command === "model") {
				// The override is already stored and applies on the next prompt
				// spawn; only the session-file write needs the child.
				ctx.ui.notify(
					`Subagent ${entryIndex} model set to ${args.trim()} (applies on next prompt).`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`Subagent ${entryIndex} is busy — run the command after it finishes.`,
					"warning",
				);
			}
		}
		return;
	}
	if (!entry.sessionFile) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Subagent ${entryIndex} has no session yet — send it a prompt first.`,
				"warning",
			);
		}
		return;
	}
	void launchCommand(pi, store, ctx, entry, command, args, extensionRoot);
}

/** Spawn the command child and finalize its message box. */
async function launchCommand(
	pi: ExtensionAPI,
	store: PersistentChatStore,
	ctx: ExtensionContext,
	entry: PersistentAgentEntry,
	command: "compact" | "model" | "name",
	args: string,
	extensionRoot: string,
): Promise<void> {
	const requestId = randomUUID();
	const sessionFile = entry.sessionFile;
	if (!sessionFile) return;
	logPersistent("command", "start", {
		requestId,
		index: entry.index,
		command,
		args: truncateText(args),
		sessionFile,
	});
	store.setRunState(entry.index, "running");
	runningSlots.add(entry.index);
	deferredSends.push({
		kind: "pending",
		requestId,
		entryIndex: entry.index,
		text: `/${command}${args ? ` ${args}` : ""}`,
	});
	drainDeferredMessageSends(pi, ctx);

	const spawnSpec = resolveCommandSpawn([
		"--session-file",
		sessionFile,
		command,
		...(args ? [args] : []),
	]);
	const startedAt = Date.now();
	const child = spawn(spawnSpec.command, spawnSpec.args, {
		cwd: ctx.cwd,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	commandChildren.set(entry.index, child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	let finalized = false;
	child.on("error", (error) => {
		finalizeCommand(
			"fail",
			`Could not start the command child: ${error.message}`,
		);
	});
	child.on("close", (code) => {
		commandChildren.delete(entry.index);
		const ok = code === 0;
		const output = ok
			? stdout.trim() || `/${command} done.`
			: stderr.trim() || `/${command} failed (exit ${code}).`;
		logPersistent("command", "finished", {
			requestId,
			index: entry.index,
			command,
			ok,
			exitCode: code,
			durationMs: Date.now() - startedAt,
		});
		finalizeCommand(ok ? "success" : "fail", output);
	});

	function finalizeCommand(state: "success" | "fail", output: string): void {
		if (!active || finalized) return;
		finalized = true;
		runningSlots.delete(entry.index);
		// A /new requested while this command child was in flight: the child is
		// dead now, so it is safe to clear the session file.
		if (pendingChannelResets.delete(entry.index)) {
			applyChannelReset(store, entry.index);
		}
		setPersistentRunState(requestId, state, output, entry.index);
		store.setRunState(entry.index, state);
		store.setRunOutput(entry.index, output);
		deferredSends.push({
			kind: "final",
			requestId,
			entryIndex: entry.index,
			state,
			text: output,
		});
		drainDeferredMessageSends(pi, ctx);
		// Free the slot for queued prompt runs.
		try {
			flushPendingRuns(pi, store, ctx, extensionRoot);
		} catch {
			// Best-effort drain; never let cleanup throw.
		}
	}
}
