/**
 * Unit tests for the persistent-chat command scoping (src/persistent/command.ts)
 * and the command child's parse/dispatch (scripts/persist-command.mjs).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
	classifyScopedCommand,
	decideTerminalInterception,
	parseModelArg,
} from "../../src/persistent/command.ts";
import { buildSelectorAdapters } from "../../src/tui/model-picker.ts";
import { formatLiveProgress } from "../../src/persistent/runner.ts";

describe("classifyScopedCommand", () => {
	it("classifies the five scoped commands", () => {
		assert.deepEqual(classifyScopedCommand("/compact"), {
			name: "compact",
			args: "",
			fullText: "/compact",
		});
		assert.deepEqual(
			classifyScopedCommand("/model anthropic/claude-sonnet-4"),
			{
				name: "model",
				args: "anthropic/claude-sonnet-4",
				fullText: "/model anthropic/claude-sonnet-4",
			},
		);
		assert.deepEqual(classifyScopedCommand("/name   my sub  agent"), {
			name: "name",
			args: "my sub  agent",
			fullText: "/name   my sub  agent",
		});
		assert.deepEqual(classifyScopedCommand("/new"), {
			name: "new",
			args: "",
			fullText: "/new",
		});
		assert.deepEqual(classifyScopedCommand("/clone"), {
			name: "clone",
			args: "",
			fullText: "/clone",
		});
	});

	it("is case-insensitive on the command name", () => {
		assert.equal(classifyScopedCommand("/COMPACT")?.name, "compact");
		assert.equal(classifyScopedCommand("/Model x")?.name, "model");
	});

	it("returns null for non-scoped commands and non-command text", () => {
		assert.equal(classifyScopedCommand("/settings"), null);
		assert.equal(classifyScopedCommand("/persist"), null);
		assert.equal(classifyScopedCommand("/close-subagent"), null);
		assert.equal(classifyScopedCommand("/fork"), null);
		assert.equal(classifyScopedCommand("hello"), null);
		assert.equal(classifyScopedCommand(""), null);
		assert.equal(classifyScopedCommand("  "), null);
		assert.equal(classifyScopedCommand("/"), null);
	});
});

describe("decideTerminalInterception", () => {
	it("passes through on the main agent (target 0)", () => {
		assert.deepEqual(decideTerminalInterception("/compact", 0), {
			action: "passthrough",
		});
	});

	it("consumes scoped commands only when targeting a subagent", () => {
		const decision = decideTerminalInterception("/compact", 1);
		assert.equal(decision.action, "consume");
		if (decision.action === "consume") {
			assert.equal(decision.command.name, "compact");
		}
		assert.equal(decideTerminalInterception("/new", 2).action, "consume");
		assert.equal(decideTerminalInterception("/clone", 3).action, "consume");
	});

	it("passes through non-scoped input when targeting a subagent", () => {
		assert.deepEqual(decideTerminalInterception("/settings", 1), {
			action: "passthrough",
		});
		assert.deepEqual(decideTerminalInterception("hello sub", 1), {
			action: "passthrough",
		});
		assert.deepEqual(decideTerminalInterception("", 1), {
			action: "passthrough",
		});
	});
});

describe("parseModelArg", () => {
	it("parses provider/model", () => {
		assert.deepEqual(parseModelArg("anthropic/claude-sonnet-4"), {
			provider: "anthropic",
			id: "claude-sonnet-4",
		});
	});

	it("handles whitespace around the arg", () => {
		assert.deepEqual(parseModelArg("  anthropic / claude-sonnet-4  "), {
			provider: "anthropic",
			id: "claude-sonnet-4",
		});
	});

	it("rejects empty and malformed args", () => {
		assert.equal(parseModelArg(""), null);
		assert.equal(parseModelArg("   "), null);
		assert.equal(parseModelArg("noid"), null);
		assert.equal(parseModelArg("/onlyid"), null);
		assert.equal(parseModelArg("provider/"), null);
	});
});

describe("buildSelectorAdapters", () => {
	it("delegates snapshot/getModel/getError to the registry", () => {
		const models = [
			{ provider: "p", id: "one" },
			{ provider: "p", id: "two" },
		];
		let refreshed = 0;
		const registry = {
			getAvailable: () => models,
			find: (provider: string, id: string) =>
				models.find((m) => m.provider === provider && m.id === id),
			refresh: async () => {
				refreshed++;
			},
			getError: () => "boom",
		};
		const adapters = buildSelectorAdapters({
			modelRegistry: registry as never,
		});
		assert.equal(adapters.runtime.getAvailableSnapshot(), models);
		assert.equal(adapters.runtime.getModel("p", "two"), models[1]);
		assert.equal(adapters.runtime.getError(), "boom");
	});

	it("refresh returns the builtin result shape and settings adapter is a no-op", async () => {
		const registry = {
			getAvailable: () => [],
			find: () => undefined,
			refresh: async () => undefined,
			getError: () => undefined,
		};
		const adapters = buildSelectorAdapters({
			modelRegistry: registry as never,
		});
		const result = await adapters.runtime.refresh();
		assert.deepEqual(result, { aborted: false, errors: new Map() });
		assert.doesNotThrow(() =>
			adapters.settings.setDefaultModelAndProvider("p", "m"),
		);
	});
});

describe("formatLiveProgress", () => {
	it("composes tool + recent output + counters", () => {
		const text = formatLiveProgress(
			{
				index: 0,
				agent: "persistent",
				status: "running",
				task: "t",
				recentOutput: ["line one", "line two"],
				toolCount: 2,
				tokens: 150,
				durationMs: 10,
				currentTool: "bash",
				currentToolArgs: "ls -la",
			} as never,
			"fallback",
		);
		assert.match(text, /⚙ bash — ls -la/);
		assert.match(text, /line one/);
		assert.match(text, /2 tools, 150 tokens/);
	});

	it("falls back to the content text when there is no progress data", () => {
		assert.equal(
			formatLiveProgress(undefined, "streamed text"),
			"streamed text",
		);
	});

	it("returns a running placeholder when nothing is available", () => {
		const text = formatLiveProgress(undefined, "");
		assert.equal(text, "(running...)");
	});
});

// ============================================================================
// Command child script (scripts/persist-command.mjs)
// ============================================================================

const scriptUrl = pathToFileURL(
	new URL("../../scripts/persist-command.mjs", import.meta.url).pathname,
).href;

async function loadScript(): Promise<{
	parseArgs: (argv: string[]) => unknown;
	runCommand: (
		session: unknown,
		modelRuntime: unknown,
		command: string,
		args: string[],
	) => Promise<string>;
}> {
	return (await import(scriptUrl)) as never;
}

describe("persist-command script", () => {
	it("parseArgs extracts --session-file, command, and args", async () => {
		const script = await loadScript();
		const parsed = script.parseArgs([
			"--session-file",
			"/tmp/persist-1.jsonl",
			"compact",
			"keep the plan",
		]);
		assert.deepEqual(parsed, {
			sessionFile: "/tmp/persist-1.jsonl",
			command: "compact",
			// The runner passes the raw args string as ONE argv element;
			// runCommand joins them back for custom instructions.
			args: ["keep the plan"],
		});
	});

	it("parseArgs tolerates unknown flags", async () => {
		const script = await loadScript();
		const parsed = script.parseArgs(["--unknown", "name", "hello"]);
		assert.deepEqual(parsed, {
			sessionFile: undefined,
			command: "name",
			args: ["hello"],
		});
	});

	it("runCommand compacts and reports the token delta", async () => {
		const script = await loadScript();
		const session = {
			compact: async (instructions: string | undefined) => {
				assert.equal(instructions, "keep the plan");
				return { tokensBefore: 100, estimatedTokensAfter: 40 };
			},
		};
		const output = await script.runCommand(session, {}, "compact", [
			"keep",
			"the",
			"plan",
		]);
		assert.equal(output, "Compacted from 100 to 40 tokens");
	});

	it("runCommand sets the model after validating it", async () => {
		const script = await loadScript();
		const calls: string[] = [];
		const modelRuntime = {
			getModel: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
		};
		const session = {
			setModel: async (model: { provider: string; id: string }) => {
				calls.push(`${model.provider}/${model.id}`);
			},
		};
		const output = await script.runCommand(session, modelRuntime, "model", [
			"anthropic/claude-sonnet-4",
		]);
		assert.deepEqual(calls, ["anthropic/claude-sonnet-4"]);
		assert.match(output, /anthropic\/claude-sonnet-4/);
	});

	it("runCommand rejects unknown models and missing auth", async () => {
		const script = await loadScript();
		const modelRuntime = {
			getModel: () => undefined,
			hasConfiguredAuth: () => false,
		};
		await assert.rejects(
			script.runCommand({}, modelRuntime, "model", ["p/nope"]),
			/Unknown model "p\/nope"/,
		);
		const modelRuntime2 = {
			getModel: (_p: string, _id: string) => ({ provider: "p", id: "m" }),
			hasConfiguredAuth: () => false,
		};
		await assert.rejects(
			script.runCommand({}, modelRuntime2, "model", ["p/m"]),
			/No configured auth/,
		);
	});

	it("runCommand renames the session", async () => {
		const script = await loadScript();
		const calls: string[] = [];
		const session = {
			setSessionName: (name: string) => {
				calls.push(name);
			},
		};
		const output = await script.runCommand(session, {}, "name", [
			"my",
			"subagent",
		]);
		assert.deepEqual(calls, ["my subagent"]);
		assert.match(output, /"my subagent"/);
	});

	it("runCommand rejects unknown commands and empty args", async () => {
		const script = await loadScript();
		await assert.rejects(
			script.runCommand({}, {}, "bogus", []),
			/Unknown persistent command: "bogus"/,
		);
		await assert.rejects(
			script.runCommand({}, {}, "name", []),
			/Usage: \/name/,
		);
		await assert.rejects(
			script.runCommand({}, {}, "model", []),
			/Usage: \/model/,
		);
	});
});
