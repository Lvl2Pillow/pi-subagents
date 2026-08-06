import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { logPersistent, truncateText } from "../../src/persistent/log.ts";

const STATE_DIR_ENV = "PI_SUBAGENTS_STATE_DIR";

describe("logPersistent", () => {
	let tmpDir: string;
	const originalEnv = process.env[STATE_DIR_ENV];

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-log-"));
		process.env[STATE_DIR_ENV] = tmpDir;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env[STATE_DIR_ENV];
		} else {
			process.env[STATE_DIR_ENV] = originalEnv;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes a JSONL line under PI_SUBAGENTS_STATE_DIR/logs", () => {
		logPersistent("cycle", "input target cycled", { before: 1, after: 0 });
		const logFile = path.join(tmpDir, "logs", "persistent.log");
		assert.ok(fs.existsSync(logFile), "log file should exist");
		const line = fs.readFileSync(logFile, "utf-8").trim();
		const parsed = JSON.parse(line) as {
			ts: string;
			area: string;
			message: string;
			data: { before: number; after: number };
		};
		assert.ok(!Number.isNaN(Date.parse(parsed.ts)), "ts should be ISO");
		assert.equal(parsed.area, "cycle");
		assert.equal(parsed.message, "input target cycled");
		assert.deepEqual(parsed.data, { before: 1, after: 0 });
	});

	it("appends multiple lines in order", () => {
		logPersistent("run", "start", { n: 1 });
		logPersistent("run", "done", { n: 2 });
		const lines = fs
			.readFileSync(path.join(tmpDir, "logs", "persistent.log"), "utf-8")
			.trim()
			.split("\n");
		assert.equal(lines.length, 2);
		assert.equal((JSON.parse(lines[0]!) as { data: { n: number } }).data.n, 1);
		assert.equal((JSON.parse(lines[1]!) as { data: { n: number } }).data.n, 2);
	});

	it("omits the data key when no payload is given", () => {
		logPersistent("session", "start");
		const parsed = JSON.parse(
			fs.readFileSync(path.join(tmpDir, "logs", "persistent.log"), "utf-8"),
		) as Record<string, unknown>;
		assert.equal(parsed.data, undefined);
	});

	it("never throws even when the state dir is unwritable", () => {
		process.env[STATE_DIR_ENV] = "/dev/null/definitely/not/writable";
		assert.doesNotThrow(() => logPersistent("cycle", "boom"));
	});
});

describe("truncateText", () => {
	it("keeps short text unchanged", () => {
		assert.equal(truncateText("hello"), "hello");
	});

	it("truncates long text with an ellipsis", () => {
		const long = "x".repeat(500);
		const out = truncateText(long, 10);
		assert.equal(out.length, 11);
		assert.ok(out.endsWith("…"));
	});
});
