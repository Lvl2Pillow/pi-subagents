/**
 * Regression E2E for two reported bugs:
 *  1. /compaction breaks input-target sync — unable to return to main agent
 *  2. After /reload, subagent's previous messages lose success status (look pending)
 *
 * The harness drives session.prompt only, so the subagent channel is targeted
 * by invoking the registered alt+n shortcut handler directly (the same cycle
 * the user triggers by keypress), then prompting.
 *
 * Run: cd agent/extensions/pi-subagents && node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/e2e/repro-compaction-reload.test.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { tryImport } from "../support/helpers.ts";
import type { RealSessionRun } from "../support/real-session-runner.ts";

const piCodingAgent = await tryImport<unknown>(
	"@earendil-works/pi-coding-agent",
);
const piAi = await tryImport<unknown>("@earendil-works/pi-ai");
const available = Boolean(piCodingAgent && piAi);

const __filename = fileURLToPath(import.meta.url);
const TEST_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const STATE_DIR = path.join(TEST_ROOT, ".tmp-e2e-state-repro");
const STATE_DIR_ENV = "PI_SUBAGENTS_STATE_DIR";

interface SessionMessage {
	role?: string;
	customType?: string;
	display?: boolean;
	details?: unknown;
	content?: unknown;
}

function runMessages(run: RealSessionRun): SessionMessage[] {
	const messages = run.parentSession.messages as SessionMessage[];
	return messages.filter(
		(message) =>
			message.role === "custom" && message.customType === "persist.run",
	);
}

/** The registered alt+n shortcut handler (target cycle main → 1 → … → main). */
function altNShortcut(session: RealSessionRun["parentSession"]) {
	const shortcuts = (
		session as never as {
			extensionRunner: {
				getShortcuts(
					opts: never,
				): Map<string, { handler: (ctx: unknown) => Promise<void> | void }>;
			};
		}
	).extensionRunner.getShortcuts({} as never);
	return shortcuts.get("alt+n");
}

describe(
	"regression: compaction + reload",
	{ skip: !available ? "pi runtime packages not available" : undefined },
	() => {
		let run: RealSessionRun | undefined;

		before(() => {
			fs.rmSync(STATE_DIR, { recursive: true, force: true });
		});
		beforeEach(() => {
			fs.rmSync(STATE_DIR, { recursive: true, force: true });
			fs.mkdirSync(STATE_DIR, { recursive: true });
			process.env[STATE_DIR_ENV] = STATE_DIR;
		});
		afterEach(async () => {
			await run?.dispose();
			run = undefined;
			fs.rmSync(STATE_DIR, { recursive: true, force: true });
			delete process.env[STATE_DIR_ENV];
		});

		it("compaction keeps the input-target cycle working (can return to main)", async () => {
			const { runRealSubagentSession, waitForPersistentRuns } =
				await import("../support/real-session-runner.ts");
			run = await runRealSubagentSession({
				prompt: "hello main",
				prompts: [
					// Grow the MAIN session (these run while target = 0) so
					// compaction has something to summarize.
					{ text: "main two" },
					{ text: "main three" },
					{ text: "main four" },
				],
				childText: "COMPACT_E2E_CHILD",
				compaction: { enabled: false, keepRecentTokens: 10 },
				respond: () => "parent ok",
			});

			const session = run.parentSession;
			const altN = altNShortcut(session);
			assert.ok(altN, "alt+n shortcut registered");

			// Target channel 1 and route two prompts to it.
			await altN.handler({ hasUI: false });
			await session.prompt("hello sub");
			await session.prompt("sub two");
			await waitForPersistentRuns(session, { expectedCompletions: 2 });

			await session.compact();

			// The extension input handler must still be functional: a new prompt
			// while targeted must still route to the subagent (target preserved).
			await session.prompt("still targeted?");
			await waitForPersistentRuns(session, { expectedCompletions: 3 });
			const runMessagesInSession = runMessages(run);
			const finals = runMessagesInSession.filter(
				(m) => ((m.details as { state?: string }).state ?? "") !== "pending",
			);
			assert.equal(
				runMessagesInSession.length,
				6,
				"3 routed prompts (hello sub, sub two, still targeted) x (pending+final)",
			);
			assert.equal(finals.length, 3);

			// Cycle back to main. With the default 3 channels the cycle is
			// 0→1→2→3→0, so from channel 1 three presses return to main.
			await altN.handler({ hasUI: false });
			await altN.handler({ hasUI: false });
			await altN.handler({ hasUI: false });
			await session.prompt("back to main?");
			await new Promise((resolve) => setTimeout(resolve, 250));
			const afterReturn = runMessages(run);
			assert.equal(
				afterReturn.length,
				runMessagesInSession.length,
				"prompt after alt+n targets main: no new persist.run pair",
			);
		});

		it("reload restores success status on previous subagent messages", async () => {
			const { runRealSubagentSession, waitForPersistentRuns } =
				await import("../support/real-session-runner.ts");
			run = await runRealSubagentSession({
				prompt: "hello main",
				childText: "RELOAD_E2E_CHILD",
				respond: () => "parent ok",
			});

			const session = run.parentSession;
			const altN = altNShortcut(session);
			assert.ok(altN, "alt+n shortcut registered");
			await altN.handler({ hasUI: false });
			await session.prompt("hello sub");
			await waitForPersistentRuns(session, { expectedCompletions: 1 });

			const before = runMessages(run);
			assert.equal(before.length, 2);
			assert.equal(
				(before[1].details as { state: string }).state,
				"success",
				"final state success before reload",
			);

			await run.parentSession.reload();

			// After reload the visible pending message must render with a
			// success glyph (via the restored live snapshot map), not stay
			// stuck on the pending spinner. Render through the extension's own
			// registered message renderer to exercise the real TUI path.
			const sessionWithRenderer = session as never as {
				extensionRunner: {
					getMessageRenderer(type: string): (
						message: unknown,
						opts: { expanded: boolean },
						theme: never,
					) => {
						render(width: number): string[];
					};
				};
			};
			const renderer =
				sessionWithRenderer.extensionRunner.getMessageRenderer("persist.run");
			const theme = {
				fg: (_name: string, text: string) => text,
				bold: (text: string) => text,
				bg: (_name: string, text: string) => text,
			} as never;
			const visible = runMessages(run).find((m) => m.display === true);
			assert.ok(visible, "visible pending message survives reload");
			const rendered = renderer(visible, { expanded: false }, theme).render(80);
			assert.ok(
				rendered.some((line) => line.includes("✓")),
				"visible message renders success glyph after reload, got:\n" +
					JSON.stringify(rendered, null, 2),
			);
			assert.ok(
				!rendered.some((line) => line.includes("…")),
				"no pending spinner after reload",
			);
		});
	},
);
