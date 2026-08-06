/**
 * Disk persistence for PersistentChatStore. Stores the always-present
 * subagent channels (their lazily-created session file and optional model
 * override) plus the active target index in a JSON file next to the
 * extension so the subagents survive a pi restart.
 *
 * Format version 2: `{version:2, entries:[{id,sessionFile,model?}], targetIndex}`.
 * Version 1 files (`{version:1, ids, targetIndex}`) are still accepted on
 * load and migrated to fresh channels with no session file. Version-2 files
 * written by older builds may carry a `mode` field (default/clone); it is
 * tolerated on load and ignored — spawn modes are gone, /clone is now a
 * command.
 *
 * The store itself stays pure (no I/O); the register layer wires load on
 * construction and save on every onChange emission. Writes are atomic
 * (write to .tmp, then rename) so a crash mid-write cannot corrupt the
 * file.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Bumped when the on-disk format changes incompatibly. */
const STATE_VERSION = 2;

export interface PersistedEntry {
	id: string;
	sessionFile: string | null;
	/** Optional per-subagent model override ("provider/id"). */
	model?: string;
}

export interface PersistedState {
	version: number;
	/** Subagent entries in slot order. Each id is `persist-${slot}`. */
	entries: PersistedEntry[];
	/** Active input target: 0 = main, 1..N = subagent slot. */
	targetIndex: number;
}

function isV2State(value: unknown): value is PersistedState {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.version !== STATE_VERSION) return false;
	if (!Array.isArray(v.entries)) return false;
	for (const entry of v.entries) {
		if (!entry || typeof entry !== "object") return false;
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== "string" || e.id.length === 0) return false;
		// Older v2 files carry a `mode` field; tolerate it without using it.
		if (e.mode !== undefined && e.mode !== "default" && e.mode !== "clone")
			return false;
		if (
			e.sessionFile !== null &&
			e.sessionFile !== undefined &&
			typeof e.sessionFile !== "string"
		)
			return false;
		if (e.model !== undefined && typeof e.model !== "string") return false;
	}
	if (
		typeof v.targetIndex !== "number" ||
		!Number.isInteger(v.targetIndex) ||
		v.targetIndex < 0
	)
		return false;
	return true;
}

interface V1State {
	version: 1;
	ids: string[];
	targetIndex: number;
}

function isV1State(value: unknown): value is V1State {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.version !== 1) return false;
	if (!Array.isArray(v.ids)) return false;
	for (const id of v.ids) {
		if (typeof id !== "string" || id.length === 0) return false;
	}
	if (
		typeof v.targetIndex !== "number" ||
		!Number.isInteger(v.targetIndex) ||
		v.targetIndex < 0
	)
		return false;
	return true;
}

/**
 * Load persisted state from `filePath`. Returns `null` when the file does
 * not exist or is corrupt/invalid (any parse or validation failure is
 * treated as "no state", never as a thrown error — the extension must keep
 * working even if the state file is bad). Version-1 files are migrated to
 * the v2 shape (default mode, no session file) so older installs upgrade
 * transparently.
 */
export function loadState(filePath: string): PersistedState | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (isV2State(parsed)) {
			// Strip unknown fields so the returned object matches the
			// PersistedState shape exactly (callers deepEqual against it).
			return {
				version: parsed.version,
				entries: parsed.entries.map((entry) => {
					const out: PersistedEntry = {
						id: entry.id,
						sessionFile: entry.sessionFile ?? null,
					};
					if (entry.model !== undefined) out.model = entry.model;
					return out;
				}),
				targetIndex: parsed.targetIndex,
			};
		}
		if (isV1State(parsed)) {
			return {
				version: parsed.version,
				entries: parsed.ids.map((id) => ({
					id,
					sessionFile: null,
				})),
				targetIndex: parsed.targetIndex,
			};
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Save persisted state to `filePath` atomically. Failures are swallowed
 * (best-effort): the extension must keep working even if the disk is full
 * or the directory is read-only.
 */
export function saveState(
	filePath: string,
	entries: readonly PersistedEntry[],
	targetIndex: number,
): void {
	try {
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true });
		const state: PersistedState = {
			version: STATE_VERSION,
			entries: entries.map((entry) => {
				const out: PersistedEntry = {
					id: entry.id,
					sessionFile: entry.sessionFile ?? null,
				};
				if (entry.model !== undefined) out.model = entry.model;
				return out;
			}),
			targetIndex,
		};
		const tmp = `${filePath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
		fs.renameSync(tmp, filePath);
	} catch {
		// Best-effort: never crash the extension on disk I/O failure.
	}
}
