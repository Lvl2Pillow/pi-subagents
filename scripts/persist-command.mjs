#!/usr/bin/env node
/**
 * Persistent-subagent command child.
 *
 * Runs a slash command against a persistent subagent's SESSION FILE, in its
 * own process, using the real pi session APIs:
 *
 *   node persist-command.mjs --session-file <jsonl> <command> [args...]
 *
 * Commands:
 *   compact [instructions]  — session.compact(), prints the token delta
 *   model <provider/model>  — session.setModel(), persisted in the session file
 *   name <name>             — session.setSessionName()
 *
 * The session file is loaded via SessionManager + createAgentSession, so the
 * subagent's model/name/messages are restored exactly as the runSync child
 * restores them on the next prompt.
 *
 * No extensions are loaded (plain SDK script), so the command child has no
 * extension side effects (no persistent-chat logging, no input routing).
 *
 * `main()` only runs when this file is the entry point; tests import
 * parseArgs / runCommand directly.
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export function parseArgs(argv) {
	const parsed = {
		sessionFile: undefined,
		command: undefined,
		args: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--session-file") {
			parsed.sessionFile = argv[++i];
			continue;
		}
		if (arg?.startsWith("--")) continue;
		if (parsed.command === undefined) {
			parsed.command = arg;
			continue;
		}
		parsed.args.push(arg);
	}
	return parsed;
}

/**
 * Execute a scoped command against a live agent session. Returns the result
 * text printed to stdout. Throws on failure (caller exits 1).
 */
export async function runCommand(session, modelRuntime, command, args) {
	switch (command) {
		case "compact": {
			const customInstructions = args.join(" ").trim() || undefined;
			const result = await session.compact(customInstructions);
			return `Compacted from ${result.tokensBefore} to ${result.estimatedTokensAfter} tokens`;
		}
		case "model": {
			const raw = args.join(" ").trim();
			if (!raw) {
				throw new Error("Usage: /model <provider/model>");
			}
			const slashIndex = raw.indexOf("/");
			if (slashIndex <= 0 || slashIndex === raw.length - 1) {
				throw new Error(`Invalid model: "${raw}". Expected <provider/model>.`);
			}
			const provider = raw.slice(0, slashIndex).trim();
			const id = raw.slice(slashIndex + 1).trim();
			const model = modelRuntime.getModel(provider, id);
			if (!model) {
				throw new Error(
					`Unknown model "${provider}/${id}". Run /model in the main agent to see available models.`,
				);
			}
			if (!modelRuntime.hasConfiguredAuth(model)) {
				throw new Error(
					`No configured auth for "${provider}/${id}". Run /login ${provider} first.`,
				);
			}
			await session.setModel(model);
			return `Model set to ${provider}/${id} (subagent ${session.getSessionName?.() ?? "session"}).`;
		}
		case "name": {
			const name = args.join(" ").trim();
			if (!name) {
				throw new Error("Usage: /name <session name>");
			}
			session.setSessionName(name);
			return `Subagent session renamed to "${name}".`;
		}
		default:
			throw new Error(
				`Unknown persistent command: "${command}". Supported: compact, model, name.`,
			);
	}
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (!parsed.sessionFile) {
		process.stderr.write("Missing --session-file\n");
		process.exit(2);
	}
	if (!parsed.command) {
		process.stderr.write("Missing command (compact | model | name)\n");
		process.exit(2);
	}
	const cwd = process.cwd();
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
	const sessionFile = parsed.sessionFile;
	let ownedSession;
	try {
		const manager = SessionManager.create(cwd, path.dirname(sessionFile));
		manager.setSessionFile(sessionFile);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const modelRuntime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
		});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const created = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: manager,
			settingsManager,
		});
		ownedSession = created.session;
		const output = await runCommand(
			ownedSession,
			modelRuntime,
			parsed.command,
			parsed.args,
		);
		process.stdout.write(`${output}\n`);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.stack || error.message : String(error)}\n`,
		);
		process.exit(1);
	} finally {
		try {
			ownedSession?.dispose();
		} catch {}
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.stack || error.message : String(error)}\n`,
		);
		process.exit(1);
	});
}
