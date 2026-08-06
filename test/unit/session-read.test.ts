import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { PersistentChatStore } from "../../src/persistent/store.ts";
import {
	readLastOutputFromSessionFile,
	restoreLastOutputsFromSessions,
} from "../../src/persistent/session-read.ts";

let tempDir: string | null = null;

function makeSessionDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "subagent-session-read-"));
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

function assistantEntry(
	text: string,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			...extra,
		},
	});
}

describe("readLastOutputFromSessionFile", () => {
	it("returns null for a missing file", () => {
		assert.equal(
			readLastOutputFromSessionFile(join(makeSessionDir(), "nope.jsonl")),
			null,
		);
	});

	it("returns null for an empty or whitespace-only file", () => {
		const dir = makeSessionDir();
		const file = join(dir, "empty.jsonl");
		writeFileSync(file, "\n\n");
		assert.equal(readLastOutputFromSessionFile(file), null);
	});

	it("returns null when only header and user entries exist", () => {
		const dir = makeSessionDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({ type: "header", id: "h" }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "hi" }] },
				}),
			].join("\n"),
		);
		assert.equal(readLastOutputFromSessionFile(file), null);
	});

	it("returns the assistant text", () => {
		const dir = makeSessionDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${assistantEntry("hello from sub")}\n`);
		assert.equal(readLastOutputFromSessionFile(file), "hello from sub");
	});

	it("returns the LAST assistant message, not an intermediate one", () => {
		const dir = makeSessionDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			[
				assistantEntry("first run output"),
				assistantEntry("second run output"),
			].join("\n"),
		);
		assert.equal(readLastOutputFromSessionFile(file), "second run output");
	});

	it("skips tool-calling assistant messages and malformed lines", () => {
		const dir = makeSessionDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			[
				assistantEntry("checking...", {
					content: [
						{ type: "text", text: "checking..." },
						{ type: "toolUse", name: "bash", input: {} },
					],
				}),
				"{not json",
				assistantEntry("final answer"),
			].join("\n"),
		);
		assert.equal(readLastOutputFromSessionFile(file), "final answer");
	});

	it("joins multiple text parts with newlines", () => {
		const dir = makeSessionDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "part one" },
						{ type: "text", text: "part two" },
					],
				},
			}),
		);
		assert.equal(readLastOutputFromSessionFile(file), "part one\npart two");
	});
});

describe("restoreLastOutputsFromSessions", () => {
	it("restores lastOutput for slots with a session file and skips others", () => {
		const dir = makeSessionDir();
		const file = join(dir, "persist-1.jsonl");
		writeFileSync(file, `${assistantEntry("survived restart")}\n`);

		const store = new PersistentChatStore();
		store.replace([{ sessionFile: file }, { sessionFile: null }], 0);

		const restored = restoreLastOutputsFromSessions(store);
		assert.equal(restored, 1);
		assert.equal(store.getAgent(1)?.lastOutput, "survived restart");
		assert.equal(store.getAgent(2)?.lastOutput, undefined);
	});

	it("returns 0 when no session file has output yet", () => {
		const store = new PersistentChatStore();
		assert.equal(restoreLastOutputsFromSessions(store), 0);
	});
});
