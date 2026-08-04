import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "../../src/api/delegation.ts";
import { parseSubagentDelegationRequest } from "../../src/slash/delegation-request.ts";
import {
	registerPromptTemplateDelegationBridge,
	type PromptTemplateBridgeEvents,
} from "../../src/slash/prompt-template-bridge.ts";

class FakeEvents implements PromptTemplateBridgeEvents {
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((entry) => entry !== handler));
	}

	emit(event: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(event, (payload) => {
			unsubscribe();
			resolve(payload);
		});
	});
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

const request: SubagentDelegationRequest = {
	requestId: "attempt-1",
	ownerRunId: "owner-1",
	nodeId: "node-1",
	agent: "reviewer",
	task: "Review evidence",
	context: "fresh",
	cwd: "/repo",
	model: "openai/gpt-5",
	thinking: "high",
	timeoutMs: 1_000,
	turnBudget: { maxTurns: 4, graceTurns: 1 },
	toolBudget: { soft: 3, hard: 5, block: "*" },
	skill: ["review"],
	artifacts: true,
	result: { kind: "structured", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
};

describe("public subagent delegation contract", () => {
	it("uses the existing prompt-template event family as the only transport", () => {
		assert.equal(SUBAGENT_DELEGATION_REQUEST_EVENT, "prompt-template:subagent:request");
		assert.equal(SUBAGENT_DELEGATION_STARTED_EVENT, "prompt-template:subagent:started");
		assert.equal(SUBAGENT_DELEGATION_UPDATE_EVENT, "prompt-template:subagent:update");
		assert.equal(SUBAGENT_DELEGATION_RESPONSE_EVENT, "prompt-template:subagent:response");
		assert.equal(SUBAGENT_DELEGATION_CANCEL_EVENT, "prompt-template:subagent:cancel");
	});

	it("strictly parses the structured owned-leaf request", () => {
		assert.deepEqual(parseSubagentDelegationRequest(request), { ok: true, request });
		const malformed = [
			[{ ...request, version: 99 }, /Unsupported delegation field: version/],
			[{ ...request, ownerRunId: "bad\nowner" }, /ownerRunId.*256 characters without newlines/],
			[{ ...request, nodeId: "x".repeat(257) }, /nodeId.*256 characters without newlines/],
			[{ ...request, thinking: "extreme" }, /thinking must be one of/],
			[{ ...request, output: false }, /Unsupported delegation field: output/],
			[{ ...request, acceptance: false }, /Unsupported delegation field: acceptance/],
			[{ ...request, agentContract: { version: 1 } }, /Unsupported delegation field: agentContract/],
			[{ ...request, result: { kind: "text", schema: {} } }, /result.schema is not supported/],
			[{ ...request, result: { kind: "structured" } }, /result.schema must be a JSON Schema object/],
			[{ ...request, task: "é".repeat(524_289) }, /task exceeds 1 MiB/],
			[{ ...request, cwd: "é".repeat(16_385) }, /cwd exceeds 32 KiB/],
			[{ ...request, agent: "é".repeat(513) }, /agent exceeds 1 KiB/],
			[{ ...request, model: "é".repeat(513) }, /model exceeds 1 KiB/],
			[{ ...request, skill: "é".repeat(513) }, /skill entry exceeds 1 KiB/],
			[{ ...request, skill: Array.from({ length: 257 }, () => "x") }, /skill supports at most 256 entries/],
			[{ ...request, skill: Array.from({ length: 256 }, () => "x".repeat(257)) }, /skill entries exceed 64 KiB in aggregate/],
			[{ ...request, result: { kind: "structured", schema: { value: "x".repeat(65_536) } } }, /result.schema exceeds 64 KiB/],
			[{ ...request, timeoutMs: 2_147_483_648 }, /timeoutMs must be <= 2147483647/],
		] as const;
		for (const [input, expected] of malformed) {
			const parsed = parseSubagentDelegationRequest(input);
			assert.equal(parsed.ok, false);
			if (!parsed.ok) assert.match(parsed.error, expected);
		}
	});

	it("accepts exact zero tool budgets for structured delegated leaves", () => {
		const zeroBudget = { hard: 0, block: "*" as const };
		const parsed = parseSubagentDelegationRequest({ ...request, toolBudget: zeroBudget });
		assert.equal(parsed.ok, true);
		if (parsed.ok) assert.deepEqual(parsed.request.toolBudget, zeroBudget);
		for (const soft of [0, 1]) {
			assert.equal(parseSubagentDelegationRequest({ ...request, toolBudget: { ...zeroBudget, soft } }).ok, false);
		}
	});

	it("rejects non-JSON schemas without executing toJSON hooks", () => {
		let calls = 0;
		const parsed = parseSubagentDelegationRequest({
			...request,
			result: {
				kind: "structured",
				schema: { toJSON: () => { calls++; return {}; } },
			},
		});
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /result.schema must be plain JSON data/);
		assert.equal(calls, 0);
	});

	it("runs structured delegation through the concurrent executor and preserves literal text metadata", async () => {
		const events = new FakeEvents();
		let ordinaryCalls = 0;
		let observedParams: Record<string, unknown> | undefined;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				ordinaryCalls++;
				return { details: { mode: "single", results: [] } };
			},
			executeStructured: async (_id, params, _signal, _ctx, onUpdate) => {
				observedParams = params as unknown as Record<string, unknown>;
				onUpdate({ details: { mode: "single", runId: "run-1", results: [{ agent: "reviewer", model: "openai/gpt-5", thinking: "high" }], progress: [{ currentTool: "read" }] } });
				return {
					details: {
						mode: "single",
						runId: "run-1",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							model: "openai/gpt-5",
							thinking: "high",
							launchContractDigest: "launch-contract-digest",
							finalOutput: '{"looks":"json"}',
							usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.01, turns: 2 },
							progressSummary: { toolCount: 6, tokens: 5, durationMs: 7 },
						}],
					},
				};
			},
		});
		const textRequest = { ...request, result: { kind: "text" as const } };
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		const updatePromise = once(events, SUBAGENT_DELEGATION_UPDATE_EVENT);
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, textRequest);
		assert.deepEqual(await startedPromise, { requestId: "attempt-1", ownerRunId: "owner-1", nodeId: "node-1" });
		assert.deepEqual(await updatePromise, { requestId: "attempt-1", ownerRunId: "owner-1", nodeId: "node-1", runId: "run-1", currentTool: "read", model: "openai/gpt-5" });
		assert.deepEqual(await responsePromise, {
			requestId: "attempt-1",
			ownerRunId: "owner-1",
			nodeId: "node-1",
			status: "completed",
			runId: "run-1",
			agent: "reviewer",
			model: "openai/gpt-5",
			thinking: "high",
			exitCode: 0,
			launchContractDigest: "launch-contract-digest",
			result: { kind: "text", text: '{"looks":"json"}' },
			usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.01, turns: 2, toolCalls: 6, durationMs: 7 },
		} satisfies SubagentDelegationResponse);
		assert.equal(ordinaryCalls, 0);
		assert.deepEqual(observedParams, {
			agent: "reviewer",
			task: "Review evidence",
			context: "fresh",
			cwd: "/repo",
			model: "openai/gpt-5",
			timeoutMs: 1_000,
			turnBudget: { maxTurns: 4, graceTurns: 1 },
			enforceHardTurnLimit: true,
			toolBudget: { soft: 3, hard: 5, block: "*" },
			skill: ["review"],
			output: false,
			acceptance: false,
			artifacts: true,
			delegatedThinkingOverride: "high",
			delegatedAllowZeroToolBudget: true,
			async: false,
			foregroundOnly: true,
			clarify: false,
		});
		bridge.dispose();
	});

	it("projects structured values and fails missing or oversized captures", async () => {
		const cases = [
			[{ ok: true }, "completed", { kind: "structured", value: { ok: true } }],
			[undefined, "failed", undefined],
			[{ value: "x".repeat(1024 * 1024) }, "failed", undefined],
		] as const;
		for (const [structuredOutput, expectedStatus, expectedResult] of cases) {
			const events = new FakeEvents();
			const bridge = registerPromptTemplateDelegationBridge({
				events,
				getContext: () => ({ cwd: "/repo" }),
				execute: async () => { throw new Error("legacy executor must remain separate"); },
				executeStructured: async () => ({
					details: {
						mode: "single",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							...(structuredOutput === undefined ? {} : { structuredOutput }),
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						}],
					},
				}),
			});
			const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: `structured-${expectedStatus}-${Math.random()}` });
			const response = await responsePromise as SubagentDelegationResponse;
			assert.equal(response.status, expectedStatus);
			assert.deepEqual(response.result, expectedResult);
			if (expectedStatus === "failed") assert.match(response.error ?? "", /structured result/);
			bridge.dispose();
		}
	});

	it("isolates logical-node ownership, exact cancellation, pre-cancellation, and reuse", async () => {
		const events = new FakeEvents();
		const releases = new Map<string, () => void>();
		const responses: SubagentDelegationResponse[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload as SubagentDelegationResponse));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("legacy executor must remain separate"); },
			executeStructured: async (id, params, signal) => await new Promise((resolve, reject) => {
				releases.set(id, () => resolve({ details: { mode: "single", results: [{ agent: params.agent, exitCode: 0, finalOutput: id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] } }));
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		});
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "owner-a", result: { kind: "text" } });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "owner-b", result: { kind: "text" } });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "owner-b", result: { kind: "text" } });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "other-node", nodeId: "node-2", result: { kind: "text" } });
		while (!releases.has("owner-a") || !releases.has("other-node")) await tick();
		await tick();
		assert.equal(responses.find((entry) => entry.requestId === "owner-b")?.status, "duplicate_node");
		assert.equal(responses.filter((entry) => entry.requestId === "owner-b").length, 1);
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId: "owner-a", ownerRunId: "wrong", nodeId: "node-1" });
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId: "owner-a", ownerRunId: "owner-1", nodeId: "wrong" });
		await tick();
		assert.equal(responses.some((entry) => entry.requestId === "owner-a"), false);
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId: "owner-a", ownerRunId: "owner-1", nodeId: "node-1" });
		while (!responses.some((entry) => entry.requestId === "owner-a")) await tick();
		assert.equal(responses.find((entry) => entry.requestId === "owner-a")?.status, "cancelled");
		releases.get("other-node")?.();
		while (!responses.some((entry) => entry.requestId === "other-node")) await tick();

		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId: "pre", ownerRunId: "owner-1", nodeId: "node-1" });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "pre", result: { kind: "text" } });
		while (!responses.some((entry) => entry.requestId === "pre")) await tick();
		assert.equal(responses.find((entry) => entry.requestId === "pre")?.status, "cancelled");

		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "reuse", result: { kind: "text" } });
		while (!releases.has("reuse")) await tick();
		releases.get("reuse")?.();
		while (!responses.some((entry) => entry.requestId === "reuse")) await tick();
		assert.equal(responses.find((entry) => entry.requestId === "reuse")?.status, "completed");
		bridge.dispose();
	});

	it("retains the unversioned prompt-template bridge as legacy fallback", async () => {
		const events = new FakeEvents();
		let structuredCalls = 0;
		let legacyCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				legacyCalls++;
				return { content: [{ type: "text", text: "legacy done" }], details: { mode: "single", results: [{ agent: "reviewer", finalOutput: "legacy done", exitCode: 0 }] } };
			},
			executeStructured: async () => {
				structuredCalls++;
				return { details: { mode: "single", results: [] } };
			},
		});
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
			requestId: "legacy-1",
			agent: "reviewer",
			task: "Legacy prompt-template delegation",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});
		const response = await responsePromise as { requestId: string; isError: boolean; contentText?: string };
		assert.equal(response.requestId, "legacy-1");
		assert.equal(response.isError, false);
		assert.equal(response.contentText, "legacy done");
		assert.equal(legacyCalls, 1);
		assert.equal(structuredCalls, 0);
		bridge.dispose();
	});
});
