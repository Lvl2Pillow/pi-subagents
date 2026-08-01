import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeAgentsForScope } from "../../src/agents/agent-selection.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

function makeAgent(name: string, source: "package" | "user" | "project", systemPrompt: string): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt,
		source,
		filePath: `/${source}/${name}.md`,
	};
}

describe("mergeAgentsForScope", () => {
	it("returns project agents when scope is project", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("project", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
	});

	it("returns user agents when scope is user", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("user", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "user");
	});

	it("prefers project agents on name collisions when scope is both", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
		assert.equal(result[0]?.systemPrompt, "project prompt");
	});

	it("keeps agents from both scopes when names are distinct", () => {
		const userAgents = [makeAgent("user-only", "user", "user prompt")];
		const projectAgents = [makeAgent("project-only", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents, projectAgents);
		assert.equal(result.length, 2);
		assert.ok(result.find((a) => a.name === "user-only" && a.source === "user"));
		assert.ok(result.find((a) => a.name === "project-only" && a.source === "project"));
	});

	it("includes package agents when no user or project agent exists", () => {
		const packageAgents = [makeAgent("scout", "package", "package prompt")];
		const result = mergeAgentsForScope("both", [], [], packageAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "package");
	});

	it("package agents provide a default that user or project agents can override", () => {
		const packageAgents = [makeAgent("scout", "package", "package prompt")];
		const userAgents = [makeAgent("scout", "user", "user prompt")];
		const projectAgents = [makeAgent("scout", "project", "project prompt")];

		assert.equal(mergeAgentsForScope("both", [], [], packageAgents)[0]?.source, "package");

		const userWins = mergeAgentsForScope("user", userAgents, [], packageAgents);
		assert.equal(userWins[0]?.source, "user");
		assert.equal(userWins[0]?.systemPrompt, "user prompt");

		const projectWins = mergeAgentsForScope("project", [], projectAgents, packageAgents);
		assert.equal(projectWins[0]?.source, "project");
		assert.equal(projectWins[0]?.systemPrompt, "project prompt");
	});
});
