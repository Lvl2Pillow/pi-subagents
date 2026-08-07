/**
 * Persistent-chat wiring: keyboard shortcut, input routing, footer status,
 * persistent-run tool message renderer, and the subagent-scoped slash
 * commands (/compact, /model, /name, /new, /clone). Registered by the
 * extension entry.
 *
 * Permanent channels: all slots exist from the start (configurable
 * slotCount, default 3); the real child session is spawned lazily at the
 * FIRST routed prompt via runPersistentPrompt. /new resets a channel
 * (interrupting a busy run first); /clone forks the main session as a
 * channel's first-prompt session.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { SubagentState } from "../shared/types.ts";
import { loadConfig } from "../extension/config.ts";
import { loadState, saveState } from "./persistence.ts";
import { restoreLastOutputsFromSessions } from "./session-read.ts";
import { resolvePersistentStateRoot } from "./session-scope.ts";
import { registerPersistentExternalRuns } from "./external-runs.ts";
import { decideInputAction } from "./routing.ts";
import {
	decideTerminalInterception,
	parseModelArg,
	type ScopedCommand,
} from "./command.ts";
import {
	isSubagentModelPickerOpen,
	openSubagentModelPicker,
} from "../tui/model-picker.ts";
import {
	PERSISTENT_RUN_TYPE,
	clearPersistentRunSnapshots,
	renderPersistentRun,
} from "./run-message.ts";
import {
	cancelQueuedPrompt,
	cloneMainSessionToChannel,
	enqueuePersistentPrompt,
	flushPendingRuns,
	interruptPersistentRun,
	resetChannelSession,
	runPersistentCommand,
	setPersistentRunnerActive,
} from "./runner.ts";
import { PERSISTENT_STATUS_KEY, buildPersistentStatus } from "./status.ts";
import { logPersistent, setPersistentLogRoot, truncateText } from "./log.ts";

export const PERSISTENT_SWITCH_SHORTCUT = "alt+n";

/**
 * State file location. Kept next to the extension so it survives across
 * pi restarts. The path is resolved from `import.meta.url` (Node ESM) so
 * it works whether the extension is loaded from source or compiled.
 *
 * Tests override the state root with PI_SUBAGENTS_STATE_DIR so e2e runs
 * never touch the real on-disk state/session files.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..", "..");

/**
 * Session-scoped state root, resolved when the main-agent session binds
 * (session_start). Each pi session gets its own channels under
 * `<stateRoot>/sessions/<sessionId>/`, so a brand-new session never sees
 * another session's subagents. Tests override the base with
 * PI_SUBAGENTS_STATE_DIR; real usage bases it on the extension root.
 */
let currentStateRoot: string | undefined;

/** Current session-scoped state root (falls back before any session binds). */
function stateRoot(): string {
	return (
		currentStateRoot ?? process.env.PI_SUBAGENTS_STATE_DIR ?? EXTENSION_ROOT
	);
}

export interface PersistentChatRegistration {
	dispose(): void;
}

export interface PersistentChatOptions {
	/** Keyboard shortcut for cycling the input target. Overrides config. */
	switchShortcut?: string;
}

export function registerPersistentChat(
	pi: ExtensionAPI,
	state: SubagentState,
	options: PersistentChatOptions = {},
): PersistentChatRegistration {
	const store = state.persistent;
	if (!store) {
		throw new Error(
			"SubagentState.persistent must be initialized before registerPersistentChat",
		);
	}
	// User-supplied config is opaque; we trust pi to validate the KeyId at
	// register time. Cast only at the boundary.
	const switchShortcut: string =
		options.switchShortcut ?? PERSISTENT_SWITCH_SHORTCUT;

	// Which main-agent session is bound right now (null until the first
	// session_start). Used to detect a switch to a new session so the
	// store can be repopulated for it.
	let boundSessionId: string | null | undefined;

	// Observability seam: channel activity is exposed through upstream's
	// read-only external-runs registry (consumers: host FleetView, Herdr,
	// third-party tooling). Idle channels are omitted.
	const unregisterExternalRuns = registerPersistentExternalRuns({
		store,
		getSessionId: () => boundSessionId ?? undefined,
	});

	/**
	 * Bind the persistent-chat subsystem to the current main-agent session:
	 * resolve the session-scoped state root, load that session's channel
	 * state into the store, and rehydrate last-run outputs. Runs on every
	 * session_start (startup, reload, resume, /new, fork) — the session id
	 * is not known before that.
	 *
	 * Loading is a no-op for a fresh session: the store is already
	 * populated with empty channels, and nothing may be written to disk
	 * until the first channel mutation. On a switch to a different session
	 * with no on-disk state, the store is silently reset (no state-file
	 * write) so the previous session's channels never leak through.
	 */
	const bindSession = (ctx: ExtensionContext): void => {
		const sessionId = (() => {
			try {
				return ctx.sessionManager.getSessionId();
			} catch {
				return undefined;
			}
		})();
		const base = process.env.PI_SUBAGENTS_STATE_DIR ?? EXTENSION_ROOT;
		const root = resolvePersistentStateRoot(base, sessionId);
		currentStateRoot = root;
		setPersistentLogRoot(root);

		const loaded = (() => {
			try {
				return loadState(join(root, "persistent-state.json"));
			} catch {
				return null;
			}
		})();
		const isFreshSession = boundSessionId === undefined;
		boundSessionId = sessionId;

		if (loaded) {
			// Persisted channels for this session: load them and rehydrate
			// each slot's last-run output from its session file. The replace
			// emits, so the (identical) snapshot is saved back to THIS
			// session's file — which is correct now that the root is set.
			store.replace(
				loaded.entries.map((entry) => ({
					sessionFile: entry.sessionFile,
					model: entry.model,
				})),
				0,
			);
			const restored = restoreLastOutputsFromSessions(store);
			logPersistent("startup", "persistent chat bound to session", {
				sessionId,
				stateFile: join(root, "persistent-state.json"),
				agents: loaded.entries.map((entry) => ({
					id: entry.id,
					sessionFile: entry.sessionFile,
				})),
				restoredLastOutputs: restored,
			});
		} else if (!isFreshSession) {
			// Switched to a session that has no on-disk state: drop the
			// previous session's channels without writing an empty file.
			store.replace([], 0, false);
		}
	};

	// Persist on every store mutation. The store is the single source of
	// truth; the file is just a snapshot. Atomics in saveState make a
	// mid-write crash safe.
	const unsubscribe = store.onChange(() => {
		const stateFile = join(stateRoot(), "persistent-state.json");
		saveState(
			stateFile,
			store.getAgents().map((entry) => ({
				id: entry.id,
				sessionFile: entry.sessionFile,
			})),
			store.getTarget(),
		);
	});

	const syncStatus = (ctx: ExtensionContext | null): void => {
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(
				PERSISTENT_STATUS_KEY,
				buildPersistentStatus(store.getTarget()),
			);
		} catch {
			// Status is best-effort; never fail input/command handling on it.
		}
	};

	pi.registerShortcut(switchShortcut as KeyId, {
		description: "Cycle input target: main agent and persistent subagents",
		handler: (ctx) => {
			const before = store.getTarget();
			store.cycle();
			const after = store.getTarget();
			syncStatus(ctx);
			logPersistent("cycle", "input target cycled", {
				shortcut: switchShortcut,
				before,
				after,
			});
		},
	});

	pi.on(
		"input",
		async (
			event: InputEvent,
			ctx: ExtensionContext,
		): Promise<InputEventResult> => {
			const decision = decideInputAction({
				text: event.text,
				hasImages: (event.images?.length ?? 0) > 0,
				target: store.getTarget(),
				agentCount: store.getAgentCount(),
			});
			logPersistent("route", "input decision", {
				action: decision.action,
				target: store.getTarget(),
				text: truncateText(event.text),
			});
			if (decision.action === "continue") {
				return { action: "continue" };
			}
			if (decision.notify && ctx.hasUI) {
				ctx.ui.notify(decision.notify, "warning");
			}
			if (decision.run) {
				// Never block the main agent: enqueue the prompt and run the
				// subagent in the background once the main agent is idle.
				enqueuePersistentPrompt(pi, store, ctx, decision.run.text, stateRoot());
			}
			return { action: "handled" };
		},
	);

	// When input is routed to a subagent (target != 0), a small set of slash
	// commands (/compact, /model, /name, /new, /clone) runs against the
	// ACTIVE subagent instead of the main agent. pi's TUI builtins are
	// handled before the extension input hook, so the Enter key is
	// intercepted at the raw terminal-input level: the keypress is consumed,
	// the editor cleared, and the command dispatched to the subagent (or its
	// model picker). All other input passes through untouched.
	const dispatchScopedCommand = (
		command: ScopedCommand,
		ctx: ExtensionContext,
	): void => {
		const target = store.getTarget();
		if (!store.getAgent(target)) return;
		if (command.name === "new") {
			resetChannelSession(store, ctx, target);
			return;
		}
		if (command.name === "clone") {
			cloneMainSessionToChannel(store, ctx, target);
			return;
		}
		if (command.name === "model") {
			const modelArg = parseModelArg(command.args);
			if (!modelArg) {
				if (command.args.trim() !== "") {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Invalid model: "${command.args}". Expected /model <provider/model>.`,
							"warning",
						);
					}
					return;
				}
				void openSubagentModelPicker(pi, ctx, store, target, stateRoot());
				return;
			}
			const model = ctx.modelRegistry.find(modelArg.provider, modelArg.id);
			if (!model) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Unknown model "${modelArg.provider}/${modelArg.id}".`,
						"warning",
					);
				}
				return;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`No configured auth for "${modelArg.provider}/${modelArg.id}". Run /login ${modelArg.provider} first.`,
						"warning",
					);
				}
				return;
			}
			runPersistentCommand(
				pi,
				store,
				ctx,
				target,
				"model",
				`${modelArg.provider}/${modelArg.id}`,
				stateRoot(),
			);
			return;
		}
		runPersistentCommand(
			pi,
			store,
			ctx,
			target,
			command.name,
			command.args,
			stateRoot(),
		);
	};

	let terminalInputDisposer: (() => void) | undefined;
	const ensureTerminalInputInterception = (ctx: ExtensionContext): void => {
		if (!ctx?.hasUI || terminalInputDisposer) return;
		terminalInputDisposer = ctx.ui.onTerminalInput((data: string) => {
			const isEnter =
				matchesKey(data, "return") || data === "\r" || data === "\n";
			if (isEnter) {
				const text = ctx.ui.getEditorText();
				const decision = decideTerminalInterception(text, store.getTarget());
				if (decision.action !== "consume") return undefined;
				logPersistent("command", "intercept", {
					target: store.getTarget(),
					command: decision.command.name,
					args: truncateText(decision.command.args),
				});
				ctx.ui.setEditorText("");
				dispatchScopedCommand(decision.command, ctx);
				return { consume: true };
			}
			// Esc on an empty editor while input targets a subagent stops its
			// current turn — mirroring main's Esc-to-abort. Pass through when an
			// extension overlay (fleet / model picker) is open so Esc still
			// closes the overlay, and when the editor has text (Esc is not
			// bound to anything there).
			if (matchesKey(data, "escape") && store.getTarget() !== 0) {
				if (state.fleetInspectorOpen || isSubagentModelPickerOpen()) {
					return undefined;
				}
				if (ctx.ui.getEditorText() !== "") return undefined;
				const target = store.getTarget();
				if (interruptPersistentRun(target)) {
					logPersistent("run", "interrupt", {
						index: target,
						source: "escape",
					});
					if (ctx.hasUI) {
						ctx.ui.notify(`Interrupted subagent ${target}.`, "info");
					}
					return { consume: true };
				}
				if (cancelQueuedPrompt(target)) {
					logPersistent("run", "cancel queued", {
						index: target,
						source: "escape",
					});
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Canceled queued prompt for subagent ${target}.`,
							"info",
						);
					}
					return { consume: true };
				}
			}
			return undefined;
		});
	};

	// The main agent finished a model turn: launch queued subagent runs at
	// this steer-equivalent boundary. A prompt routed while the main agent is
	// streaming is deferred until the current turn completes (not until the
	// whole task finishes) — the same moment pi injects steering messages.
	// Launching mid-run is safe: the child is a separate process and never
	// touches the main agent's turn loop.
	pi.on("turn_end", (_event, ctx) => {
		flushPendingRuns(pi, store, ctx, stateRoot(), {
			allowWhileStreaming: true,
		});
	});

	// Safety net: drain whatever is left once the agent fully settles in case
	// no turn_end was observed (e.g. an unusual run-finalization path).
	pi.on("agent_settled", (_event, ctx) => {
		flushPendingRuns(pi, store, ctx, stateRoot());
	});

	// Stop launching and finalize in-flight runs as no-ops when the session
	// goes away (quit, reload, new session) so a background child finishing
	// late never touches an invalidated extension ctx.
	pi.on("session_shutdown", () => {
		setPersistentRunnerActive(false);
	});

	pi.registerMessageRenderer(PERSISTENT_RUN_TYPE, (message, options, theme) => {
		const details = message.details as {
			requestId?: string;
			agentIndex?: number;
			state?: string;
			text?: string;
		};
		if (
			!details ||
			typeof details.requestId !== "string" ||
			typeof details.agentIndex !== "number"
		) {
			return undefined;
		}
		return renderPersistentRun(
			{
				requestId: details.requestId,
				agentIndex: details.agentIndex,
				state:
					details.state === "success" || details.state === "fail"
						? details.state
						: "pending",
				text: typeof details.text === "string" ? details.text : "",
			},
			options,
			theme,
			{
				maxCollapsedLines: loadConfig().persistentChat?.maxCollapsedLines ?? 1,
			},
		);
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		bindSession(ctx);
		syncStatus(ctx);
		ensureTerminalInputInterception(ctx);
	});

	pi.on("session_shutdown", () => {
		clearPersistentRunSnapshots();
	});

	return {
		dispose: () => {
			unregisterExternalRuns();
			unsubscribe();
			terminalInputDisposer?.();
			terminalInputDisposer = undefined;
		},
	};
}
