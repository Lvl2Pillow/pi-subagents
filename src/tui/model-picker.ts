/**
 * Subagent model picker: reuses pi's builtin ModelSelectorComponent — the same
 * UI the main `/model` command opens — via ctx.ui.custom in non-overlay mode
 * gets full search, scrollable list (windowed, with N/M indicator), provider
 * badges and login hints without reimplementing them.
 *
 * The builtin component is fed adapters:
 * - a ModelRuntime facade backed by ctx.modelRegistry (snapshot + refresh);
 * - a no-op SettingsManager, so selecting here does NOT change the global
 *   default model (the override applies only to the subagent).
 *
 * Selection is applied to the subagent via runPersistentCommand, which stores
 * the override and records it in the subagent's session file when one exists.
 */

import {
	ModelSelectorComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PersistentChatStore } from "../persistent/store.ts";
import { runPersistentCommand } from "../persistent/runner.ts";

export interface SelectorAdapters {
	settings: SettingsManager;
	runtime: ModelRuntime;
}

/**
 * Build the adapter pair the builtin selector needs from the extension
 * context. Pure (no TUI) so it is unit-testable.
 */
export function buildSelectorAdapters(
	ctx: Pick<ExtensionContext, "modelRegistry">,
): SelectorAdapters {
	return {
		settings: {
			setDefaultModelAndProvider: () => {
				// Subagent overrides must not touch the global default model.
			},
		} as unknown as SettingsManager,
		runtime: {
			getAvailableSnapshot: () => ctx.modelRegistry.getAvailable(),
			getModel: (provider: string, id: string) =>
				ctx.modelRegistry.find(provider, id),
			refresh: async () => {
				await ctx.modelRegistry.refresh();
				return { aborted: false, errors: new Map<string, Error>() };
			},
			getError: () => ctx.modelRegistry.getError(),
		} as unknown as ModelRuntime,
	};
}

/**
 * Open the model picker for the targeted persistent subagent using pi's
 * builtin selector UI. On selection, applies the model via
 * runPersistentCommand (stores the override + records it in the subagent's
 * session file when one exists); Escape cancels.
 */
/** True while the subagent model picker overlay is open (guards Esc routing). */
let pickerOpen = false;

export function isSubagentModelPickerOpen(): boolean {
	return pickerOpen;
}

export async function openSubagentModelPicker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	store: PersistentChatStore,
	entryIndex: number,
	extensionRoot: string,
): Promise<void> {
	if (!ctx.hasUI) return;
	const adapters = buildSelectorAdapters(ctx);
	pickerOpen = true;
	try {
		await ctx.ui.custom<string | undefined>(
			(tui, _theme, _keybindings, done) =>
				new ModelSelectorComponent(
					tui,
					ctx.model,
					adapters.settings,
					adapters.runtime,
					ctx.scopedModels,
					(model) => {
						const fullId = `${model.provider}/${model.id}`;
						runPersistentCommand(
							pi,
							store,
							ctx,
							entryIndex,
							"model",
							fullId,
							extensionRoot,
						);
						done(fullId);
					},
					() => done(undefined),
				),
			// Non-overlay: replaces the editor row in place (full width), exactly like
			// the builtin /model selector. Overlay mode would float it on top instead.
			{ overlay: false },
		);
	} finally {
		pickerOpen = false;
	}
}
