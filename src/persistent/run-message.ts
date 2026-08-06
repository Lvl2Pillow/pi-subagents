/**
 * Tool message for persistent-subagent runs: one custom message per routed
 * user prompt showing the pending -> success/fail lifecycle, collapsible /
 * expandable via ctrl+o (MessageRenderOptions.expanded).
 *
 * The initial details stored in the session are "pending"; the live snapshot
 * map (module-level, like slash-live-state) tracks the final state so the
 * visible message updates in-session. No restart restore (not in spec).
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type {
	ExtensionContext,
	MessageRenderOptions,
} from "@earendil-works/pi-coding-agent";

export const PERSISTENT_RUN_TYPE = "persist.run";

export type PersistentRunState = "pending" | "success" | "fail";

export interface PersistentRunDetails {
	requestId: string;
	agentIndex: number;
	state: PersistentRunState;
	text: string;
}

type Theme = ExtensionContext["ui"]["theme"];

interface RunSnapshot {
	details: PersistentRunDetails;
	version: number;
}

const liveSnapshots = new Map<string, RunSnapshot>();
let versionCounter = 1;

function nextVersion(): number {
	return versionCounter++;
}

/** Build the initial "pending" details for a routed prompt. */
export function buildPersistentRunDetails(
	requestId: string,
	agentIndex: number,
	text: string,
): PersistentRunDetails {
	return { requestId, agentIndex, state: "pending", text };
}

/** Record the final state for a requestId so the visible message updates. */
export function setPersistentRunState(
	requestId: string,
	state: Exclude<PersistentRunState, "pending">,
	text: string,
	agentIndex = -1,
): void {
	liveSnapshots.set(requestId, {
		details: { requestId, state, text, agentIndex },
		version: nextVersion(),
	});
}

/**
 * Record live streaming progress for a running request (state stays
 * "pending"; only the text grows). The box renders the latest snapshot on
 * every frame, so expanded output streams in as the child works.
 */
export function setPersistentRunLive(requestId: string, text: string): void {
	liveSnapshots.set(requestId, {
		details: { requestId, state: "pending", text, agentIndex: -1 },
		version: nextVersion(),
	});
}

/** Latest renderable state for a stored details object (live first, else stored). */
export function getPersistentRunRenderable(
	details: PersistentRunDetails,
): PersistentRunDetails {
	const snapshot = liveSnapshots.get(details.requestId);
	if (snapshot) return snapshot.details;
	return details;
}

const DEFAULT_MAX_COLLAPSED_LINES = 1;

/**
 * Pure render of a persistent run message, styled like a tool execution:
 * a Box with the tool-call background (toolPendingBg while running,
 * toolSuccessBg / toolErrorBg on completion) and toolTitle/toolOutput fg.
 * Expanded (ctrl+o) shows full output.
 *
 * Collapsed output shows up to `config.maxCollapsedLines` lines (default 1)
 * followed by a dim "… (ctrl+o to expand)" hint when more is hidden.
 *
 * Returns a LIVE component: render() re-reads the snapshot map on every
 * frame, so the same message box transitions pending -> success/fail in
 * place (like a tool call) instead of appending a separate message.
 */
export function renderPersistentRun(
	details: PersistentRunDetails,
	options: MessageRenderOptions,
	theme: Theme,
	config?: { maxCollapsedLines?: number },
): Component {
	const maxCollapsedLines = Math.max(
		1,
		Math.trunc(config?.maxCollapsedLines ?? DEFAULT_MAX_COLLAPSED_LINES),
	);
	return {
		render(width: number): string[] {
			const renderable = getPersistentRunRenderable(details);
			const bgToken =
				renderable.state === "success"
					? "toolSuccessBg"
					: renderable.state === "fail"
						? "toolErrorBg"
						: "toolPendingBg";
			const glyph =
				renderable.state === "success"
					? theme.fg("success", "✓")
					: renderable.state === "fail"
						? theme.fg("error", "✗")
						: theme.fg("accent", "…");
			const title = `${glyph} ${theme.fg("toolTitle", theme.bold(`Subagent ${details.agentIndex}`))}`;
			const body = renderable.text || "(no output)";
			const lines = body.split(/\r?\n/).filter((line) => line.length > 0);
			const truncated = !options.expanded && lines.length > maxCollapsedLines;
			const visible = options.expanded
				? lines
				: lines.slice(0, maxCollapsedLines);
			const box = new Box(1, 1, (text) => theme.bg(bgToken, text));
			box.addChild(new Text(title, 0, 0));
			if (visible.length > 0) {
				box.addChild(
					new Text(theme.fg("toolOutput", visible.join("\n")), 0, 1),
				);
				if (truncated) {
					box.addChild(new Text(theme.fg("dim", "… (ctrl+o to expand)"), 0, 0));
				}
			}
			return box.render(width);
		},
		invalidate(): void {
			// Stateless live render: nothing to cache, so nothing to invalidate.
		},
	};
}

/** Clear all live snapshots (session shutdown). */
export function clearPersistentRunSnapshots(): void {
	liveSnapshots.clear();
}

/**
 * Rebuild the live snapshot map from persisted session entries so that
 * messages re-rendered after a session reload (which emits session_shutdown
 * -> clearPersistentRunSnapshots) resolve to their final state instead of
 * sticking on "pending" forever. Mirrors restoreSlashFinalSnapshots.
 */
export function restorePersistentRunSnapshots(entries: unknown[]): void {
	liveSnapshots.clear();
	for (const entry of entries) {
		const e = entry as {
			type?: string;
			customType?: string;
			details?: unknown;
		};
		if (e?.type !== "custom_message" || e.customType !== PERSISTENT_RUN_TYPE) {
			continue;
		}
		const details = e.details as Partial<PersistentRunDetails> | undefined;
		if (!details || typeof details.requestId !== "string") continue;
		if (details.state !== "success" && details.state !== "fail") continue;
		liveSnapshots.set(details.requestId, {
			details: {
				requestId: details.requestId,
				agentIndex:
					typeof details.agentIndex === "number" ? details.agentIndex : -1,
				state: details.state,
				text: typeof details.text === "string" ? details.text : "",
			},
			version: nextVersion(),
		});
	}
}
