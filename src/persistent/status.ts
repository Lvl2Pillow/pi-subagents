/**
 * Footer status for the persistent-chat input target.
 */

export const PERSISTENT_STATUS_KEY = "persistent.target";

/**
 * Footer status: speaker icon + target number.
 * 0 = main agent; 1+ = each persistent subagent in spawn order.
 */
export function buildPersistentStatus(target: number): string {
	return `🔊 ${target}`;
}
