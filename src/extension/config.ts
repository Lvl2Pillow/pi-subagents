import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ArtifactDirPreference,
	ExtensionConfig,
} from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";

const ARTIFACT_DIR_PREFERENCES = new Set<ArtifactDirPreference>([
	"project",
	"session",
	"temp",
]);

export function getConfigPath(): string {
	return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}

function readConfigForUpdate(configPath = getConfigPath()): ExtensionConfig {
	if (!fs.existsSync(configPath)) return {};
	const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
	}
	const config = parsed as Record<string, unknown>;
	if (
		config.artifactDir !== undefined &&
		!ARTIFACT_DIR_PREFERENCES.has(config.artifactDir as ArtifactDirPreference)
	) {
		throw new Error(
			`config.artifactDir must be "project", "session", or "temp"`,
		);
	}
	const pc = config.persistentChat;
	if (pc !== undefined) {
		if (!pc || typeof pc !== "object" || Array.isArray(pc)) {
			throw new Error(`config.persistentChat must be a JSON object`);
		}
		const shortcut = (pc as Record<string, unknown>).switchShortcut;
		if (
			shortcut !== undefined &&
			(typeof shortcut !== "string" || !shortcut.trim())
		) {
			throw new Error(
				`config.persistentChat.switchShortcut must be a non-empty string`,
			);
		}
		const maxCollapsedLines = (pc as Record<string, unknown>).maxCollapsedLines;
		if (
			maxCollapsedLines !== undefined &&
			(typeof maxCollapsedLines !== "number" ||
				!Number.isInteger(maxCollapsedLines) ||
				maxCollapsedLines < 1)
		) {
			throw new Error(
				`config.persistentChat.maxCollapsedLines must be a positive integer`,
			);
		}
		const slotCount = (pc as Record<string, unknown>).slotCount;
		if (
			slotCount !== undefined &&
			(typeof slotCount !== "number" ||
				!Number.isInteger(slotCount) ||
				slotCount < 1 ||
				slotCount > 8)
		) {
			throw new Error(
				`config.persistentChat.slotCount must be an integer between 1 and 8`,
			);
		}
	}
	return parsed;
}

export function saveConfig(
	config: ExtensionConfig,
	configPath = getConfigPath(),
): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		configPath,
		`${JSON.stringify(config, null, "\t")}\n`,
		"utf-8",
	);
}

export function updateConfig(
	updater: (config: ExtensionConfig) => ExtensionConfig,
): ExtensionConfig {
	const configPath = getConfigPath();
	const next = updater(readConfigForUpdate(configPath));
	saveConfig(next, configPath);
	return next;
}

export function loadConfig(): ExtensionConfig {
	const configPath = getConfigPath();
	try {
		return readConfigForUpdate(configPath);
	} catch (error) {
		console.error(
			`Failed to load subagent config from '${configPath}':`,
			error,
		);
	}
	return {};
}
