import { readFileSync } from "node:fs";
import type { PersistentChatStore } from "./store.ts";

/**
 * Extract the final output of the most recent run from a persistent
 * subagent session file (JSONL of pi session entries). Every routed prompt
 * appends the child's full turn to the file, so the LAST assistant text
 * message is the final output of the last run. Returns null when the file
 * is missing, empty, or contains no assistant text yet.
 */
export function readLastOutputFromSessionFile(
	sessionFile: string,
): string | null {
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch {
		return null;
	}
	let last: string | null = null;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			// Skip malformed/partial lines (e.g. an interrupted write).
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const message = (entry as { message?: unknown }).message;
		if (typeof message !== "object" || message === null) continue;
		const msg = message as { role?: unknown; content?: unknown };
		if (msg.role !== "assistant") continue;
		const parts = Array.isArray(msg.content) ? msg.content : [];
		const text = parts
			.filter(
				(part): part is { type: "text"; text: string } =>
					typeof part === "object" &&
					part !== null &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("\n");
		if (text.length > 0) last = text;
	}
	return last;
}

/**
 * Rehydrate the transient per-slot last-run output from the on-disk session
 * files (which persist independently). Called on startup after the store is
 * loaded, so the fleet's "Last output:" row survives pi restarts. Returns
 * the number of slots restored.
 */
export function restoreLastOutputsFromSessions(
	store: Pick<PersistentChatStore, "getAgents" | "setRunOutput">,
): number {
	let restored = 0;
	for (const entry of store.getAgents()) {
		if (!entry.sessionFile) continue;
		const lastOutput = readLastOutputFromSessionFile(entry.sessionFile);
		if (lastOutput) {
			store.setRunOutput(entry.index, lastOutput);
			restored++;
		}
	}
	return restored;
}
