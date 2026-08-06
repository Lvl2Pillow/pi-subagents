import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PERSISTENT_RUN_TYPE,
	buildPersistentRunDetails,
	clearPersistentRunSnapshots,
	getPersistentRunRenderable,
	renderPersistentRun,
	restorePersistentRunSnapshots,
	setPersistentRunLive,
	setPersistentRunState,
	type PersistentRunDetails,
} from "../../src/persistent/run-message.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
};

/** Theme that records which bg token was requested during render. */
function recordingTheme(): {
	theme: typeof theme;
	bgCalls: string[];
} {
	const bgCalls: string[] = [];
	return {
		bgCalls,
		theme: {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
			bg: (name: string, text: string) => {
				bgCalls.push(name);
				return text;
			},
		},
	};
}

function rendered(details: PersistentRunDetails, expanded = false): string {
	const text = renderPersistentRun(
		details,
		{ expanded, outputPad: 0 },
		theme as never,
	);
	return text.render(80).join("\n");
}

describe("buildPersistentRunDetails", () => {
	it("creates a pending details object", () => {
		const details = buildPersistentRunDetails("req-1", 2, "hello sub");
		assert.deepEqual(details, {
			requestId: "req-1",
			agentIndex: 2,
			state: "pending",
			text: "hello sub",
		});
	});
});

describe("setPersistentRunState / getPersistentRunRenderable", () => {
	it("updates the live snapshot for a requestId and serves it", () => {
		clearPersistentRunSnapshots();
		const details = buildPersistentRunDetails("req-live", 1, "task");
		setPersistentRunState("req-live", "success", "child output");
		assert.equal(getPersistentRunRenderable(details).state, "success");
		assert.equal(getPersistentRunRenderable(details).text, "child output");
		clearPersistentRunSnapshots();
	});

	it("falls back to the stored details when no live snapshot exists", () => {
		clearPersistentRunSnapshots();
		const details = buildPersistentRunDetails("req-stale", 3, "task");
		assert.deepEqual(getPersistentRunRenderable(details), details);
	});

	it("supports fail states", () => {
		clearPersistentRunSnapshots();
		const details = buildPersistentRunDetails("req-fail", 1, "task");
		setPersistentRunState("req-fail", "fail", "boom");
		assert.equal(getPersistentRunRenderable(details).state, "fail");
		assert.equal(getPersistentRunRenderable(details).text, "boom");
		clearPersistentRunSnapshots();
	});
});

describe("setPersistentRunLive", () => {
	it("keeps the state pending while streaming text grows", () => {
		const details = buildPersistentRunDetails("live-1", 2, "prompt text");
		setPersistentRunLive("live-1", "chunk one");
		const renderable = getPersistentRunRenderable(details);
		assert.equal(renderable.state, "pending");
		assert.equal(renderable.text, "chunk one");
		setPersistentRunLive("live-1", "chunk one\nchunk two");
		assert.equal(
			getPersistentRunRenderable(details).text,
			"chunk one\nchunk two",
		);
		clearPersistentRunSnapshots();
	});

	it("a final state overwrites live streaming text", () => {
		const details = buildPersistentRunDetails("live-2", 1, "prompt");
		setPersistentRunLive("live-2", "still streaming");
		setPersistentRunState("live-2", "success", "final output", 1);
		assert.deepEqual(getPersistentRunRenderable(details), {
			requestId: "live-2",
			agentIndex: 1,
			state: "success",
			text: "final output",
		});
		clearPersistentRunSnapshots();
	});
});

describe("restorePersistentRunSnapshots", () => {
	it("rebuilds the live map from persisted session entries", () => {
		clearPersistentRunSnapshots();
		const details = buildPersistentRunDetails("req-restore", 1, "task");
		// Simulate the persisted pair after a reload: visible box (pending,
		// display:true) + invisible final message (success, display:false).
		restorePersistentRunSnapshots([
			{
				type: "custom_message",
				customType: PERSISTENT_RUN_TYPE,
				display: true,
				details: { ...details },
			},
			{
				type: "custom_message",
				customType: PERSISTENT_RUN_TYPE,
				display: false,
				details: {
					requestId: "req-restore",
					agentIndex: 1,
					state: "success",
					text: "child output",
				},
			},
		]);
		assert.equal(
			getPersistentRunRenderable(details).state,
			"success",
			"visible pending box resolves to success after restore",
		);
		assert.equal(getPersistentRunRenderable(details).text, "child output");
		clearPersistentRunSnapshots();
	});

	it("ignores non-persist.run entries and pending-only entries", () => {
		clearPersistentRunSnapshots();
		const details = buildPersistentRunDetails("req-ignore", 2, "task");
		restorePersistentRunSnapshots([
			{ type: "custom_message", customType: "other.type", details },
			{
				type: "custom_message",
				customType: PERSISTENT_RUN_TYPE,
				details: { ...details, state: "pending" },
			},
			{ type: "message", role: "user", content: [] },
		]);
		assert.deepEqual(getPersistentRunRenderable(details), details);
		clearPersistentRunSnapshots();
	});

	it("starts empty when no entries are given", () => {
		clearPersistentRunSnapshots();
		restorePersistentRunSnapshots([]);
		const details = buildPersistentRunDetails("req-empty", 1, "task");
		assert.deepEqual(getPersistentRunRenderable(details), details);
	});
});

describe("renderPersistentRun", () => {
	it("renders pending state with Subagent N title", () => {
		const out = rendered(buildPersistentRunDetails("req-p", 1, "hello sub"));
		assert.ok(out.includes("Subagent 1"), out);
		assert.equal(out.includes("persist.run"), false, out);
		assert.equal(out.includes("persist-1"), false, out);
		assert.ok(out.includes("hello sub"), out);
	});

	it("renders success state with Subagent N title and output", () => {
		const out = rendered({
			requestId: "req-s",
			agentIndex: 1,
			state: "success",
			text: "done ok",
		});
		assert.ok(out.includes("Subagent 1"), out);
		assert.ok(out.includes("✓"), out);
		assert.ok(out.includes("done ok"), out);
	});

	it("renders fail state with Subagent N title", () => {
		const out = rendered({
			requestId: "req-f",
			agentIndex: 2,
			state: "fail",
			text: "errored",
		});
		assert.ok(out.includes("Subagent 2"), out);
		assert.ok(out.includes("✗"), out);
		assert.ok(out.includes("errored"), out);
	});

	it("transitions the same component in place from pending to success", () => {
		clearPersistentRunSnapshots();
		const details = buildPersistentRunDetails("req-t", 3, "task");
		const component = renderPersistentRun(
			details,
			{ expanded: false, outputPad: 0 },
			theme as never,
		);
		const pending = component.render(80).join("\n");
		assert.ok(pending.includes("Subagent 3"), pending);
		assert.ok(pending.includes("…"), pending);
		assert.equal(pending.includes("✓"), false, pending);

		// Completion updates the snapshot; re-rendering the SAME component
		// shows success in place (no separate message needed).
		setPersistentRunState("req-t", "success", "done output", 3);
		const after = component.render(80).join("\n");
		assert.ok(after.includes("✓"), after);
		assert.ok(after.includes("done output"), after);
		assert.equal(after.includes("…"), false, after);
		clearPersistentRunSnapshots();
	});

	it("collapses multi-line output by default and expands with ctrl+o", () => {
		const details: PersistentRunDetails = {
			requestId: "req-x",
			agentIndex: 1,
			state: "success",
			text: "line one\nline two\nline three",
		};
		const collapsed = rendered(details, false);
		assert.ok(collapsed.includes("line one"));
		assert.equal(collapsed.includes("line two"), false);
		assert.ok(collapsed.includes("… (ctrl+o to expand)"), collapsed);
		const expanded = rendered(details, true);
		assert.ok(expanded.includes("line one"));
		assert.ok(expanded.includes("line two"));
		assert.ok(expanded.includes("line three"));
		assert.equal(expanded.includes("(ctrl+o to expand)"), false, expanded);
	});

	it("respects configurable maxCollapsedLines", () => {
		const details: PersistentRunDetails = {
			requestId: "req-y",
			agentIndex: 2,
			state: "success",
			text: "line one\nline two\nline three\nline four",
		};
		const collapsed = renderPersistentRun(
			details,
			{ expanded: false, outputPad: 0 },
			theme as never,
			{ maxCollapsedLines: 3 },
		).render(80);
		const text = collapsed.join("\n");
		assert.ok(text.includes("line one"));
		assert.ok(text.includes("line three"));
		assert.equal(text.includes("line four"), false, text);
		assert.ok(text.includes("… (ctrl+o to expand)"), text);
		// A short output that fits in the budget needs no expand hint.
		const short = renderPersistentRun(
			details,
			{ expanded: false, outputPad: 0 },
			theme as never,
			{ maxCollapsedLines: 10 },
		).render(80);
		assert.equal(short.join("\n").includes("(ctrl+o to expand)"), false);
	});

	it("exposes the custom message type", () => {
		assert.equal(PERSISTENT_RUN_TYPE, "persist.run");
	});

	it("renders with the tool-call pending background (toolPendingBg)", () => {
		const { theme: recTheme, bgCalls } = recordingTheme();
		const component = renderPersistentRun(
			buildPersistentRunDetails("req-bg-p", 1, "hello sub"),
			{ expanded: false, outputPad: 0 },
			recTheme as never,
		);
		component.render(80);
		assert.ok(
			bgCalls.includes("toolPendingBg"),
			`expected toolPendingBg in bg calls, got: ${bgCalls.join(", ")}`,
		);
	});

	it("renders with the tool-call success background (toolSuccessBg)", () => {
		const { theme: recTheme, bgCalls } = recordingTheme();
		const component = renderPersistentRun(
			{
				requestId: "req-bg-s",
				agentIndex: 1,
				state: "success",
				text: "done ok",
			},
			{ expanded: false, outputPad: 0 },
			recTheme as never,
		);
		component.render(80);
		assert.ok(
			bgCalls.includes("toolSuccessBg"),
			`expected toolSuccessBg in bg calls, got: ${bgCalls.join(", ")}`,
		);
	});

	it("renders with the tool-call error background (toolErrorBg)", () => {
		const { theme: recTheme, bgCalls } = recordingTheme();
		const component = renderPersistentRun(
			{
				requestId: "req-bg-f",
				agentIndex: 1,
				state: "fail",
				text: "errored",
			},
			{ expanded: false, outputPad: 0 },
			recTheme as never,
		);
		component.render(80);
		assert.ok(
			bgCalls.includes("toolErrorBg"),
			`expected toolErrorBg in bg calls, got: ${bgCalls.join(", ")}`,
		);
	});
});
