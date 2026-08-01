import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildOverrideConfig,
	discoverAgents,
	discoverAgentsAll,
	removeAgentOverride,
} from "../../src/agents/agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(cwd: string, name: string, body: string): void {
	const filePath = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

function writeUserAgent(home: string, name: string, body: string): void {
	const filePath = path.join(home, ".pi", "agent", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("agent overrides", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-subagents-project-"),
		);
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined)
			delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		if (originalExtraAgentDirs === undefined)
			delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = originalExtraAgentDirs;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("prefers project subagents.defaultModel over user defaultModel", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultModel: "deepseek-v4-flash" },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultModel: "deepseek-v4-pro" },
		});
		writeProjectAgent(
			tempProject,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
		);

		const implementer = discoverAgents(tempProject, "both").agents.find(
			(agent) => agent.name === "implementer",
		);
		assert.ok(implementer);
		assert.equal(implementer.model, "deepseek-v4-pro");
	});

	it("applies subagents.defaultThinking only when thinking is unset", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultThinking: " low ",
				agentOverrides: {
					"override-thinking": { thinking: "xhigh" },
				},
			},
		});
		writeUserAgent(
			tempHome,
			"user-default",
			`---\nname: user-default\ndescription: User agent\n---\n\nUse the default.\n`,
		);
		writeProjectAgent(
			tempProject,
			"override-thinking",
			`---\nname: override-thinking\ndescription: Thinking override agent\n---\n\nUse the override.\n`,
		);
		writeProjectAgent(
			tempProject,
			"project-default",
			`---\nname: project-default\ndescription: Project agent\n---\n\nUse the default.\n`,
		);
		writeProjectAgent(
			tempProject,
			"explicit-off",
			`---\nname: explicit-off\ndescription: Explicitly disabled\nthinking: false\n---\n\nStay off.\n`,
		);

		const discovered = discoverAgentsAll(tempProject);
		assert.equal(
			discovered.project.find((agent) => agent.name === "override-thinking")
				?.thinking,
			"xhigh",
		);
		assert.equal(
			discovered.user.find((agent) => agent.name === "user-default")?.thinking,
			"low",
		);
		assert.equal(
			discovered.project.find((agent) => agent.name === "project-default")
				?.thinking,
			"low",
		);
		assert.equal(
			discovered.project.find((agent) => agent.name === "explicit-off")
				?.thinking,
			false,
		);
	});

	it("prefers project subagents.defaultThinking over user defaultThinking", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultThinking: "low" },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultThinking: "high" },
		});
		writeUserAgent(
			tempHome,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
		);

		const implementer = discoverAgents(tempProject, "both").agents.find(
			(agent) => agent.name === "implementer",
		);
		assert.ok(implementer);
		assert.equal(implementer.thinking, "high");
	});

	it("surfaces malformed defaultThinking settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		for (const defaultThinking of ["", 42]) {
			writeJson(settingsPath, { subagents: { defaultThinking } });
			assert.throws(
				() => discoverAgents(tempProject, "both"),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes(settingsPath) &&
					error.message.includes("defaultThinking"),
			);
		}
	});

	it("applies subagents.defaultModel to custom agents without a frontmatter model", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultModel: "deepseek-v4-flash",
				agentOverrides: {
					implementer: { model: "deepseek-v4-pro" },
				},
			},
		});
		writeProjectAgent(
			tempProject,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
		);
		writeProjectAgent(
			tempProject,
			"auditor",
			`---\nname: auditor\ndescription: Audit code\nmodel: google/gemini-3-pro\n---\n\nAudit the code.\n`,
		);
		writeProjectAgent(
			tempProject,
			"scout-copy",
			`---\nname: scout-copy\ndescription: Scout code\n---\n\nScout the code.\n`,
		);

		const agents = discoverAgents(tempProject, "both").agents;
		assert.equal(
			agents.find((agent) => agent.name === "implementer")?.model,
			"deepseek-v4-pro",
		);
		assert.equal(
			agents.find((agent) => agent.name === "auditor")?.model,
			"google/gemini-3-pro",
		);
		assert.equal(
			agents.find((agent) => agent.name === "scout-copy")?.model,
			"deepseek-v4-flash",
		);
	});

	it("surfaces malformed subagent default model settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				defaultModel: "",
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes(settingsPath) &&
				error.message.includes("defaultModel"),
		);
	});

	it("applies acceptance role precedence and false clearing across agent scopes", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { acceptanceRole: "read-only" },
					scout: { acceptanceRole: "read-only" },
					implementer: { acceptanceRole: "read-only" },
				},
			},
		});
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { acceptanceRole: "writer" },
					scout: { acceptanceRole: false },
					implementer: { acceptanceRole: false },
				},
			},
		});
		writeProjectAgent(
			tempProject,
			"reviewer",
			`---\nname: reviewer\ndescription: Project reviewer\n---\n\nReview the code.\n`,
		);
		writeProjectAgent(
			tempProject,
			"scout",
			`---\nname: scout\ndescription: Project scout\n---\n\nScout the code.\n`,
		);
		writeProjectAgent(
			tempProject,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
		);

		const agents = discoverAgents(tempProject, "both").agents;
		assert.equal(
			agents.find((agent) => agent.name === "reviewer")?.acceptanceRole,
			"writer",
		);
		assert.equal(
			agents.find((agent) => agent.name === "scout")?.acceptanceRole,
			undefined,
		);
		assert.equal(
			agents.find((agent) => agent.name === "implementer")?.acceptanceRole,
			undefined,
		);
		assert.equal(
			agents.find((agent) => agent.name === "implementer")?.override?.scope,
			"project",
		);
	});

	it("does not apply project settings overrides when scope is user", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } },
			},
		});
		writeUserAgent(
			tempHome,
			"reviewer",
			`---\nname: reviewer\ndescription: User reviewer\n---\n\nReview the code.\n`,
		);

		const reviewer = discoverAgents(tempProject, "user").agents.find(
			(agent) => agent.name === "reviewer",
		);
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override?.scope, "user");
	});

	it("does not apply user settings overrides when scope is project", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeProjectAgent(
			tempProject,
			"reviewer",
			`---\nname: reviewer\ndescription: Project reviewer\n---\n\nReview the code.\n`,
		);

		const reviewer = discoverAgents(tempProject, "project").agents.find(
			(agent) => agent.name === "reviewer",
		);
		assert.ok(reviewer);
		assert.notEqual(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override, undefined);
	});

	it("does not read malformed out-of-scope settings files", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			'{"subagents":',
			"utf-8",
		);
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } },
			},
		});
		writeProjectAgent(
			tempProject,
			"reviewer",
			`---\nname: reviewer\ndescription: Project reviewer\n---\n\nReview the code.\n`,
		);

		const reviewer = discoverAgents(tempProject, "project").agents.find(
			(agent) => agent.name === "reviewer",
		);
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
		assert.equal(reviewer.override?.scope, "project");
	});

	it("fills in unset fields on a custom project agent from project agentOverrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					implementer: {
						model: "anthropic/claude-sonnet-4-6",
						fallbackModels: ["openai/gpt-5-mini"],
						thinking: "high",
						systemPromptMode: "append",
						inheritProjectContext: true,
						inheritSkills: true,
						defaultContext: "fork",
						acceptanceRole: "writer",
						tools: ["bash", "mcp:xcodebuild_list_sims"],
						skills: ["tdd"],
						subagentOnlyExtensions: ["./tools/child-review.ts"],
						completionGuard: false,
					},
				},
			},
		});
		writeProjectAgent(
			tempProject,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
		);

		const implementer = discoverAgents(tempProject, "both").agents.find(
			(agent) => agent.name === "implementer",
		);
		assert.ok(implementer);
		assert.equal(implementer.source, "project");
		assert.equal(implementer.model, "anthropic/claude-sonnet-4-6");
		assert.deepEqual(implementer.fallbackModels, ["openai/gpt-5-mini"]);
		assert.equal(implementer.thinking, "high");
		assert.equal(implementer.systemPromptMode, "append");
		assert.equal(implementer.inheritProjectContext, true);
		assert.equal(implementer.inheritSkills, true);
		assert.equal(implementer.defaultContext, "fork");
		assert.equal(implementer.acceptanceRole, "writer");
		assert.deepEqual(implementer.tools, ["bash"]);
		assert.deepEqual(implementer.mcpDirectTools, ["xcodebuild_list_sims"]);
		assert.deepEqual(implementer.skills, ["tdd"]);
		assert.deepEqual(implementer.subagentOnlyExtensions, [
			"./tools/child-review.ts",
		]);
		assert.equal(implementer.completionGuard, false);
		assert.equal(implementer.override?.scope, "project");
		assert.equal(
			implementer.override?.path,
			path.join(tempProject, ".pi", "settings.json"),
		);
	});

	it("fills in unset fields on a custom user agent from user agentOverrides", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					implementer: { model: "anthropic/claude-sonnet-4-6" },
				},
			},
		});
		writeUserAgent(
			tempHome,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
		);

		const implementer = discoverAgents(tempProject, "both").agents.find(
			(agent) => agent.name === "implementer",
		);
		assert.ok(implementer);
		assert.equal(implementer.source, "user");
		assert.equal(implementer.model, "anthropic/claude-sonnet-4-6");
		assert.equal(implementer.override?.scope, "user");
	});

	it("applies user agentOverrides to a custom project agent when project settings have no entry", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					implementer: { model: "anthropic/claude-sonnet-4-6" },
				},
			},
		});
		writeProjectAgent(
			tempProject,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
		);

		const implementer = discoverAgents(tempProject, "both").agents.find(
			(agent) => agent.name === "implementer",
		);
		assert.ok(implementer);
		assert.equal(implementer.source, "project");
		assert.equal(implementer.model, "anthropic/claude-sonnet-4-6");
		assert.equal(implementer.override?.scope, "user");
	});

	it("prefers project agentOverrides over user agentOverrides on a custom project agent", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					implementer: { model: "anthropic/claude-sonnet-4-6" },
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: { implementer: { model: "openai/gpt-5.4" } },
			},
		});
		writeProjectAgent(
			tempProject,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
		);

		const implementer = discoverAgents(tempProject, "both").agents.find(
			(agent) => agent.name === "implementer",
		);
		assert.ok(implementer);
		assert.equal(implementer.model, "openai/gpt-5.4");
		assert.equal(implementer.override?.scope, "project");
	});

	it("keeps explicit custom frontmatter fields over matching agentOverrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					implementer: {
						model: "anthropic/claude-sonnet-4-6",
						thinking: "high",
						tools: ["bash"],
						skills: ["override-skill"],
						inheritProjectContext: true,
						defaultContext: "fork",
						acceptanceRole: "writer",
						completionGuard: true,
					},
				},
			},
		});
		writeProjectAgent(
			tempProject,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\nmodel: google/gemini-3-pro\nthinking: medium\ntools: read, mcp:local_tool\nskills: agent-skill\ninheritProjectContext: false\ndefaultContext: fresh\nacceptanceRole: read-only\ncompletionGuard: false\n---\n\nDrive the failing test first.\n`,
		);

		const implementer = discoverAgents(tempProject, "both").agents.find(
			(agent) => agent.name === "implementer",
		);
		assert.ok(implementer);
		assert.equal(implementer.source, "project");
		assert.equal(implementer.model, "google/gemini-3-pro");
		assert.equal(implementer.thinking, "medium");
		assert.deepEqual(implementer.tools, ["read"]);
		assert.deepEqual(implementer.mcpDirectTools, ["local_tool"]);
		assert.deepEqual(implementer.skills, ["agent-skill"]);
		assert.equal(implementer.inheritProjectContext, false);
		assert.equal(implementer.defaultContext, "fresh");
		assert.equal(implementer.acceptanceRole, "read-only");
		assert.equal(implementer.completionGuard, false);
		assert.equal(implementer.override, undefined);
	});

	it("leaves a custom agent untouched when no agentOverrides entry matches its name", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeProjectAgent(
			tempProject,
			"implementer",
			`---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
		);

		const implementer = discoverAgents(tempProject, "both").agents.find(
			(agent) => agent.name === "implementer",
		);
		assert.ok(implementer);
		assert.equal(implementer.model, undefined);
		assert.equal(implementer.override, undefined);
	});

	it("does not create a settings file when removing a non-existent override", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		assert.equal(fs.existsSync(settingsPath), false);
		removeAgentOverride(tempProject, "reviewer", "user");
		assert.equal(fs.existsSync(settingsPath), false);
	});

	it("surfaces malformed settings files instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, '{"subagents":', "utf-8");

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes(settingsPath) &&
				error.message.includes("Failed to parse settings file"),
		);
	});

	it("surfaces settings read failures without mislabeling them as parse errors", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(settingsPath, { recursive: true });

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes(settingsPath) &&
				error.message.includes("Failed to read settings file"),
		);
	});

	it("surfaces malformed override entries instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: {
						inheritProjectContext: "true",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes(settingsPath) &&
				error.message.includes("reviewer") &&
				error.message.includes("inheritProjectContext"),
		);
	});

	it("surfaces malformed acceptance role override values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: {
						acceptanceRole: "observer",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes(settingsPath) &&
				error.message.includes("reviewer") &&
				error.message.includes("acceptanceRole"),
		);
	});

	it("surfaces malformed completion guard override values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: {
						completionGuard: "false",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes(settingsPath) &&
				error.message.includes("reviewer") &&
				error.message.includes("completionGuard"),
		);
	});

	it("builds false sentinels when an override clears fields", () => {
		const override = buildOverrideConfig(
			{
				model: "openai-codex/gpt-5.4-mini",
				fallbackModels: ["openai/gpt-5-mini"],
				thinking: "high",
				systemPromptMode: "append",
				inheritProjectContext: true,
				inheritSkills: false,
				defaultContext: "fork",
				acceptanceRole: "read-only",
				skills: ["safe-bash"],
				tools: ["bash"],
				mcpDirectTools: ["xcodebuild_list_sims"],
				subagentOnlyExtensions: ["./tools/base-child.ts"],
				completionGuard: false,
			},
			{
				model: undefined,
				fallbackModels: undefined,
				thinking: undefined,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				defaultContext: undefined,
				acceptanceRole: undefined,
				skills: undefined,
				tools: undefined,
				mcpDirectTools: undefined,
				subagentOnlyExtensions: undefined,
				completionGuard: true,
			},
		);

		assert.deepEqual(override, {
			model: false,
			fallbackModels: false,
			thinking: false,
			systemPromptMode: "replace",
			inheritProjectContext: false,
			defaultContext: false,
			acceptanceRole: false,
			skills: false,
			tools: false,
			subagentOnlyExtensions: false,
			completionGuard: true,
		});
	});
});
