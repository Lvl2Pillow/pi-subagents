/**
 * Point PI_SUBAGENTS_STATE_DIR at a throwaway dir so unit tests that call the
 * extension's register function (which writes startup logs / persistent state)
 * never touch the real extension root. Returns the dir (left in the OS temp
 * dir for the process lifetime; the OS reaps it).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STATE_DIR_ENV = "PI_SUBAGENTS_STATE_DIR";

export function isolatePersistentStateDir(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-unit-state-"),
	);
	process.env[STATE_DIR_ENV] = dir;
	return dir;
}
