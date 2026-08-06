/**
 * Per-main-agent-session scoping for persistent-chat state.
 *
 * Each pi session is its own "main agent + N channels" world: the persistent
 * state (channel table) and channel session files live under
 * `<stateRoot>/sessions/<sessionId>/`, keyed by the MAIN agent's session id
 * (from `ctx.sessionManager.getSessionId()`). Continuing/resuming the same
 * main session (same id) restores its channels; a brand-new pi session (new
 * id) starts with clean channels and never sees another session's subagents.
 *
 * Session ids are pi-generated (alphanumeric + `._-`, validated by
 * `assertValidSessionId`), so they are safe as directory names. The resolver
 * still guards against path traversal defensively: an id that does not match
 * the safe charset falls back to the base root.
 */

import { join } from "node:path";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve the per-session state root for a main-agent session id.
 *
 * @param base The base state root (PI_SUBAGENTS_STATE_DIR in tests, the
 *   extension root in real usage).
 * @param sessionId The main agent's session id, or null/undefined when no
 *   session is bound yet.
 * @returns `<base>/sessions/<sessionId>` for a valid id, otherwise `base`.
 */
export function resolvePersistentStateRoot(
	base: string,
	sessionId: string | null | undefined,
): string {
	if (
		typeof sessionId === "string" &&
		sessionId.length > 0 &&
		SAFE_SESSION_ID.test(sessionId)
	) {
		return join(base, "sessions", sessionId);
	}
	return base;
}
