/**
 * Unit tests for per-session scoping of persistent-chat state.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { resolvePersistentStateRoot } from "../../src/persistent/session-scope.ts";

const BASE = "/tmp/pi-subagents-base";

describe("resolvePersistentStateRoot", () => {
	it("scopes under sessions/<sessionId> for a valid session id", () => {
		assert.equal(
			resolvePersistentStateRoot(BASE, "abc12345"),
			join(BASE, "sessions", "abc12345"),
		);
	});

	it("accepts the full pi session-id charset (alnum + ._-)", () => {
		assert.equal(
			resolvePersistentStateRoot(BASE, "a1.b-2_c"),
			join(BASE, "sessions", "a1.b-2_c"),
		);
	});

	it("falls back to the base root when no session id is bound", () => {
		assert.equal(resolvePersistentStateRoot(BASE, undefined), BASE);
		assert.equal(resolvePersistentStateRoot(BASE, null), BASE);
		assert.equal(resolvePersistentStateRoot(BASE, ""), BASE);
	});

	it("rejects path-traversal session ids defensively", () => {
		assert.equal(resolvePersistentStateRoot(BASE, ".."), BASE);
		assert.equal(resolvePersistentStateRoot(BASE, "../evil"), BASE);
		assert.equal(resolvePersistentStateRoot(BASE, "/etc/passwd"), BASE);
		assert.equal(resolvePersistentStateRoot(BASE, "a/b"), BASE);
		// Leading dot is not a valid pi session id; must not escape base.
		assert.equal(resolvePersistentStateRoot(BASE, ".hidden"), BASE);
	});
});
