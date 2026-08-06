/**
 * Pure command-scoping logic for the persistent-chat input target.
 *
 * When input is routed to a persistent subagent (target != 0), a small set of
 * slash commands runs against the ACTIVE agent instead of the main agent:
 *
 *   /compact [instructions] — compact the subagent's session
 *   /model [provider/model] — switch the subagent's model (bare opens a picker)
 *   /name <name>            — rename the subagent's session
 *   /new                    — reset the subagent's channel (interrupt + clear)
 *   /clone                  — clone the main session as the subagent's first
 *                             prompt (only while the channel has no session)
 *
 * Everything else (agnostic commands like /settings, plain text, and any
 * other slash command) passes through untouched.
 *
 * Pure state (no pi imports) so it is unit-testable without a pi runtime.
 */

export type ScopedCommandName = "compact" | "model" | "name" | "new" | "clone";

export interface ScopedCommand {
	name: ScopedCommandName;
	/** Raw args after the command name (may be empty). */
	args: string;
	/** The original trimmed text, e.g. "/compact keep the plan". */
	fullText: string;
}

export type TerminalInterception =
	{ action: "passthrough" } | { action: "consume"; command: ScopedCommand };

const SCOPED_COMMANDS: ReadonlySet<string> = new Set([
	"compact",
	"model",
	"name",
	"new",
	"clone",
]);

/**
 * Parse a slash-command line. Returns the scoped command when the line is
 * exactly one of the subagent-scoped commands, otherwise null (including for
 * empty text, non-slash text, and any other slash command).
 */
export function classifyScopedCommand(text: string): ScopedCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const spaceIndex = trimmed.indexOf(" ");
	const rawName =
		spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
	const name = rawName.toLowerCase();
	if (!SCOPED_COMMANDS.has(name)) return null;
	const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	return { name: name as ScopedCommandName, args, fullText: trimmed };
}

/**
 * Decide what the terminal-Enter interception should do for a line of input.
 * Scoped commands are consumed (and routed to the active subagent) only when
 * the input target is a subagent; on the main agent they pass through so the
 * TUI builtin handlers run normally.
 */
export function decideTerminalInterception(
	text: string,
	target: number,
): TerminalInterception {
	if (target === 0) return { action: "passthrough" };
	const command = classifyScopedCommand(text);
	if (!command) return { action: "passthrough" };
	return { action: "consume", command };
}

/**
 * Parse a `/model` argument. Accepts "provider/id" (with or without the
 * leading slash in the id, e.g. "anthropic/claude-sonnet-4"). Returns null
 * when the arg is empty or malformed.
 */
export function parseModelArg(
	raw: string,
): { provider: string; id: string } | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null;
	const provider = trimmed.slice(0, slashIndex).trim();
	const id = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !id) return null;
	return { provider, id };
}
