// Deliberate deviation: pi-agent-core 0.83.0 emits `isError` on tool results at
// runtime (see dist/agent-loop.js) but omits it from the AgentToolResult type.
// The import makes this a module so `declare module` merges instead of shadowing.
// Tracked against the 0.81.0-declared / 0.83.0-installed version mismatch.
import type {} from "@earendil-works/pi-agent-core";

declare module "@earendil-works/pi-agent-core" {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- type param required for declaration merging
	interface AgentToolResult<T> {
		isError?: boolean;
	}
}
