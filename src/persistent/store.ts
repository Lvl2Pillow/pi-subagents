/**
 * Persistent-chat registry: a fixed set of always-present subagent channels
 * plus the current input target.
 *
 * Channel semantics: slots are 1..slotCount and are ALWAYS occupied — the
 * channel exists the moment the store is created and never closes. A channel
 * has no session until its first routed prompt (`sessionFile === null`); the
 * first prompt lazily creates `persistent-sessions/persist-N.jsonl`. The
 * slot number is the identity: `persist-N` is just a string form of the slot.
 *
 * Target semantics: 0 = main agent; 1..slotCount = the channel of that
 * number. Every channel is targetable.
 *
 * Pure state (no pi imports) so it is unit-testable without a pi runtime.
 */

export const DEFAULT_PERSISTENT_SLOT_COUNT = 3;
export const MAX_PERSISTENT_SLOT_COUNT = 8;

export type PersistentRunState = "idle" | "running" | "success" | "fail";

export interface PersistentAgentEntry {
	/** Always `persist-${index}` — the slot number is the identity. */
	id: string;
	/** Slot number 1..slotCount. */
	index: number;
	/**
	 * Session file, created lazily at the FIRST routed prompt (null before
	 * that). Persisted so the subagent's session survives pi restarts. A
	 * null value also means /clone is allowed (first-prompt-only).
	 */
	sessionFile: string | null;
	/**
	 * Per-subagent model override ("provider/id"), set via /model. Persisted;
	 * passed as --model on every prompt spawn. When the subagent already has a
	 * session, /model also persists the change into the session file itself.
	 */
	model?: string;
	/** Transient last-run state for the fleet UI (not persisted). */
	lastState: PersistentRunState;
	/** Transient last-run final output for the fleet UI (rehydrated from the
	 * session file on startup; not stored in the state file). */
	lastOutput?: string;
}

/** Clamp a slot-count config value to the allowed 1..8 range. */
export function clampSlotCount(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_PERSISTENT_SLOT_COUNT;
	return Math.max(1, Math.min(Math.trunc(value), MAX_PERSISTENT_SLOT_COUNT));
}

export class PersistentChatStore {
	/**
	 * Fixed-size channel table. `slots[0]` is always null (main agent has no
	 * entry). `slots[i]` for i in 1..slotCount is always a
	 * PersistentAgentEntry — channels never close.
	 */
	private slots: (PersistentAgentEntry | null)[];
	private targetIndex = 0;
	private listeners = new Set<() => void>();

	constructor(slotCount: number = DEFAULT_PERSISTENT_SLOT_COUNT) {
		this.slots = PersistentChatStore.makeChannels(clampSlotCount(slotCount));
	}

	private static makeChannels(
		slotCount: number,
	): (PersistentAgentEntry | null)[] {
		const out: (PersistentAgentEntry | null)[] = [null];
		for (let i = 1; i <= slotCount; i++) {
			out.push({
				id: `persist-${i}`,
				index: i,
				sessionFile: null,
				lastState: "idle",
			});
		}
		return out;
	}

	getSlotCount(): number {
		return this.slots.length - 1;
	}

	/**
	 * Cycle the input target through main (0) and every channel in ascending
	 * order, wrapping back to main. With slotCount 0 this is a no-op.
	 */
	cycle(): void {
		const count = this.getSlotCount();
		if (count < 1) return;
		const next = (this.targetIndex + 1) % (count + 1);
		this.targetIndex = next;
		this.emit();
	}

	setTarget(target: number): boolean {
		if (
			!Number.isInteger(target) ||
			target < 0 ||
			target > this.getSlotCount()
		) {
			return false;
		}
		if (target !== 0 && this.slots[target] === null) return false;
		this.targetIndex = target;
		this.emit();
		return true;
	}

	getTarget(): number {
		return this.targetIndex;
	}

	/** Number of subagent channels (always slotCount — channels never close). */
	getAgentCount(): number {
		return this.getSlotCount();
	}

	/**
	 * Return every channel in ascending order (1, 2, ..., slotCount). Each
	 * entry's `id` is `persist-${index}` and its `index` is the slot number.
	 */
	getAgents(): readonly PersistentAgentEntry[] {
		const out: PersistentAgentEntry[] = [];
		for (let i = 1; i <= this.getSlotCount(); i++) {
			const entry = this.slots[i];
			if (entry) out.push(entry);
		}
		return out;
	}

	reset(): void {
		this.slots = PersistentChatStore.makeChannels(this.getSlotCount());
		this.targetIndex = 0;
		this.emit();
	}

	/**
	 * Reset a channel to its pre-session state: no session file, idle, no
	 * output. The channel keeps its id, index and model override (a /model
	 * choice survives /new). Returns false for out-of-range indexes.
	 */
	resetChannel(index: number): boolean {
		const entry = this.slots[index];
		if (!entry) return false;
		entry.sessionFile = null;
		entry.lastState = "idle";
		delete entry.lastOutput;
		this.emit();
		return true;
	}

	/**
	 * Record the lazily-created session file for a subagent. Returns false
	 * when the slot is empty or the file is invalid.
	 */
	setSessionFile(index: number, sessionFile: string): boolean {
		const entry = this.slots[index];
		if (!entry || typeof sessionFile !== "string" || sessionFile.length === 0)
			return false;
		entry.sessionFile = sessionFile;
		this.emit();
		return true;
	}

	/** Return the entry at a slot, or `undefined` for out-of-range slots. */
	getAgent(index: number): PersistentAgentEntry | undefined {
		if (!Number.isInteger(index) || index < 1 || index > this.getSlotCount())
			return undefined;
		return this.slots[index] ?? undefined;
	}

	/** Update the transient last-run state used by the fleet UI. */
	setRunState(index: number, state: PersistentRunState): boolean {
		const entry = this.slots[index];
		if (!entry) return false;
		entry.lastState = state;
		this.emit();
		return true;
	}

	/** Record the transient final output of the last run (fleet UI). */
	setRunOutput(index: number, output: string): boolean {
		const entry = this.slots[index];
		if (!entry) return false;
		entry.lastOutput = output;
		this.emit();
		return true;
	}

	/**
	 * Set the per-subagent model override ("provider/id"). Returns false when
	 * the slot is empty or the value is not a non-empty string.
	 */
	setModel(index: number, model: string): boolean {
		const entry = this.slots[index];
		if (!entry || typeof model !== "string" || model.length === 0) return false;
		entry.model = model;
		this.emit();
		return true;
	}

	/** Clear the per-subagent model override (fall back to the main model). */
	clearModel(index: number): boolean {
		const entry = this.slots[index];
		if (!entry) return false;
		delete entry.model;
		this.emit();
		return true;
	}

	/**
	 * Replace the store contents (used for loading persisted state from disk).
	 * The channel table is rebuilt to a full slotCount-sized set; persisted
	 * entries are matched positionally (entry i → channel i+1) and pad
	 * missing channels with fresh empty ones; extra entries are truncated.
	 * The target is clamped to a valid value (0 or a channel).
	 *
	 * `emit` defaults to true (the persistence listener saves the snapshot).
	 * Pass false when repopulating on session bind with no on-disk state, so
	 * a brand-new session does not write an empty state file at startup.
	 */
	replace(
		agents: ReadonlyArray<
			Partial<Pick<PersistentAgentEntry, "sessionFile" | "model">>
		>,
		targetIndex: number,
		emit = true,
	): void {
		const next = PersistentChatStore.makeChannels(this.getSlotCount());
		let i = 0;
		for (const agent of agents) {
			const index = i + 1;
			if (index > this.getSlotCount()) break;
			next[index] = {
				id: `persist-${index}`,
				index,
				sessionFile: agent.sessionFile ?? null,
				model: agent.model,
				lastState: "idle",
			};
			i += 1;
		}
		this.slots = next;
		const clampedTarget = Math.max(
			0,
			Math.min(targetIndex, this.getSlotCount()),
		);
		this.targetIndex =
			clampedTarget === 0 || next[clampedTarget] !== null ? clampedTarget : 0;
		if (emit) this.emit();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
