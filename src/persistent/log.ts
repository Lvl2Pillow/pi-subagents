/**
 * Minimal append-only debug logger for the persistent-chat subsystem.
 *
 * Writes one JSONL line per event to `<STATE_ROOT>/logs/persistent.log`,
 * where STATE_ROOT follows PI_SUBAGENTS_STATE_DIR (tests) or the extension
 * root (real usage). Lines carry `ts`, `area`, `message`, and an optional
 * `data` payload so a crash or misbehavior can be reconstructed after the
 * fact without any other instrumentation.
 *
 * Logging is strictly best-effort: it never throws, so a full disk or
 * unwritable path can never break input/command handling.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..", "..");

/**
 * Session-scoped log root, set by registerPersistentChat when a main-agent
 * session binds (the same root the persistent state lives under). Logs for a
 * session land in `<root>/logs/persistent.log` so one session's debug trail
 * never mixes with another's.
 */
let logRootOverride: string | undefined;

/** Point the debug log at a (session-scoped) state root. */
export function setPersistentLogRoot(root: string): void {
	logRootOverride = root;
}

function logPath(): string {
	const stateRoot =
		process.env.PI_SUBAGENTS_STATE_DIR ?? logRootOverride ?? EXTENSION_ROOT;
	return join(stateRoot, "logs", "persistent.log");
}

/** Truncate free-form text for log payloads (keep lines small). */
export function truncateText(text: string, max = 200): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

/**
 * Append one JSONL line to the persistent-chat debug log.
 * `area` groups events (e.g. "cycle", "run", "session", "route").
 */
export function logPersistent(
	area: string,
	message: string,
	data?: unknown,
): void {
	try {
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			area,
			message,
			...(data === undefined ? {} : { data }),
		});
		fs.mkdirSync(dirname(logPath()), { recursive: true });
		fs.appendFileSync(logPath(), `${line}\n`, "utf-8");
	} catch {
		// Best-effort: never fail the caller on logging errors.
	}
}
