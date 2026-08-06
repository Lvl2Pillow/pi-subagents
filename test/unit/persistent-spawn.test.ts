import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	buildPersistentSpawnAgent,
	persistentSessionFile,
} from "../../src/persistent/spawn.ts";
import {
	buildPiArgs,
	resolvePiLaunchToolPlan,
} from "../../src/runs/shared/pi-args.ts";

describe("persistentSessionFile", () => {
	it("builds a stable per-index session file under the extension root", () => {
		const root = "/tmp/ext-root";
		assert.equal(
			persistentSessionFile(root, 1),
			path.join(root, "persistent-sessions", "persist-1.jsonl"),
		);
		assert.equal(
			persistentSessionFile(root, 3),
			path.join(root, "persistent-sessions", "persist-3.jsonl"),
		);
	});
});

describe("buildPersistentSpawnAgent", () => {
	it("inherits the full main agent: project context, skills, tools, extensions", () => {
		const agent = buildPersistentSpawnAgent();
		assert.equal(agent.name, "persistent");
		assert.equal(agent.inheritProjectContext, true);
		assert.equal(agent.inheritSkills, true);
		// Undefined means "inherit everything" — no tool/extension restriction.
		assert.equal(agent.tools, undefined);
		assert.equal(agent.extensions, undefined);
		assert.equal(agent.subagentOnlyExtensions, undefined);
		assert.equal(agent.systemPrompt, "");
		assert.equal(agent.systemPromptMode, "append");
		assert.equal(agent.source, "user");
		assert.equal(agent.completionGuard, false);
	});
});

describe("persistent spawn args (sandbox contract)", () => {
	it("builds child args with a session file and no extension/tool/skill restrictions", () => {
		const sessionFile = path.join(
			os.tmpdir(),
			"persist-session-test",
			"persist-1.jsonl",
		);
		try {
			const { args } = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "hello sub",
				sessionEnabled: true,
				sessionFile,
				inheritProjectContext: true,
				inheritSkills: true,
				systemPrompt: null,
			});
			assert.ok(args.includes("--session"));
			assert.ok(args.includes(sessionFile));
			assert.equal(args.includes("--no-extensions"), false);
			assert.equal(args.includes("--no-skills"), false);
			assert.equal(args.includes("--no-context-files"), false);
			assert.equal(args.includes("--no-tools"), false);
			assert.equal(args.includes("--tools"), false);
		} finally {
			fs.rmSync(path.dirname(sessionFile), { recursive: true, force: true });
		}
	});

	it("does not create an explicit tool allowlist for the persistent agent", () => {
		const agent = buildPersistentSpawnAgent();
		const plan = resolvePiLaunchToolPlan({
			tools: agent.tools,
			extensions: agent.extensions,
			subagentOnlyExtensions: agent.subagentOnlyExtensions,
			cwd: process.cwd(),
		});
		assert.equal(plan.explicitToolAllowlist, false);
		assert.equal(plan.disableAmbientExtensions, false);
		assert.equal(plan.effectiveToolAllowlist.length, 0);
	});
});
