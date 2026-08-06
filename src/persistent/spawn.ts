/**
 * Lazy persistent-subagent spawn: pure helpers for session-file naming and
 * the synthetic child AgentConfig used to spawn the real child session.
 *
 * The sandbox contract is enforced purely by inheritance: the persistent
 * agent leaves `tools`/`extensions`/`subagentOnlyExtensions` undefined and
 * sets `inheritProjectContext`/`inheritSkills` true, so `buildPiArgs` emits
 * no `--no-extensions`, no `--no-skills`, no `--no-context-files`, and no
 * `--tools` restriction — ambient extensions (including the sandbox) load
 * in the child unchanged.
 */

import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.ts";

/**
 * Stable per-index session file for a persistent subagent, kept under the
 * extension root so it survives pi restarts.
 */
export function persistentSessionFile(
	extensionRoot: string,
	index: number,
): string {
	return path.join(
		extensionRoot,
		"persistent-sessions",
		`persist-${index}.jsonl`,
	);
}

/**
 * Synthetic in-memory AgentConfig for the persistent child. Everything is
 * inherited from the main agent (no tool/extension restriction), so the
 * sandbox extension remains active inside the child.
 */
export function buildPersistentSpawnAgent(): AgentConfig {
	return {
		name: "persistent",
		description: "Persistent chat subagent",
		systemPrompt: "",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: true,
		source: "user",
		filePath: "",
		completionGuard: false,
	};
}
