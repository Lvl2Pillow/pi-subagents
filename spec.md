# Fork change spec

This file tracks every intentional change this fork makes to upstream pi-subagents. Use it to keep the fork's deviations traceable: when rebasing on upstream, or when reviewing what this fork does differently, read this first.

Each entry records what changed, why, and where it lives in the code. Append a new entry for every fork change. Keep entries factual; no promises, no justification beyond the reason for the change.

## 1. Removed intercom

The fork no longer ships the external `intercom` tool or the `pi-intercom` cross-process bridge. Children talk to the parent through the native supervisor channel only.

### Removed

- `intercom` child tool (was registered by pi-intercom or as a fallback).
- `pi-intercom` bridge interop, including the `result-intercom.ts` module.
- `subagent:result-intercom` and `subagent:control-intercom` events.
- `SUBAGENT_ORCHESTRATOR_TARGET_ENV` and `orchestratorTarget` plumbing between processes.
- Run options: `intercomTarget`, `childIntercomTarget`, `orchestratorIntercomTarget`, `intercomSessionName`, `deliverIntercomResults`.
- `notifyChannels: "intercom"`.
- `intercomBridge.resultDelivery` (config option and delivery path).
- `intercom` fallback tool registration and `includeIntercomFallback`.

### Kept

- Native supervisor channel: child-facing `contact_supervisor` tool, parent-facing `subagent_supervisor` reply tool.
- `IntercomEventBus` (`on`/`emit` over `pi.events`) with `subagent:detach-request` / `subagent:detach-response`.
- `allowIntercomDetach` / `intercomEvents` run options; detached runs carry `detachedReason: "intercom coordination"`.
- `intercomBridge` config: `mode` (`off` | `fork-only` | `always`) and `instructionFile`. `applyIntercomBridgeToAgent` appends the bridge instructions and adds `contact_supervisor` to the child tool list.
- `INTERCOM_BRIDGE_MARKER` (`"Intercom orchestration channel:"`): gate for `allowIntercomDetach` and idempotence check when appending bridge instructions.
- `subagent:async-complete` event.
- `{orchestratorTarget}` interpolation in bridge instruction templates (points at the supervisor session target).

### Where

- Deleted: `src/intercom/result-intercom.ts`, `test/integration/intercom-result-delivery.test.ts`, `test/unit/result-intercom.test.ts`.
- New: `src/runs/background/result-normalize.ts` (normalization helpers moved out of `result-intercom.ts`).
- Touched: `src/extension/*`, `src/intercom/intercom-bridge.ts`, `src/intercom/native-supervisor-channel.ts`, `src/runs/{foreground,background,shared}/*`, `src/shared/types.ts`, integration and unit tests, `agents/*.md`, `skills/pi-subagents/**`, `README.md`.

### Notes

- The `intercom` name survives only in internal identifiers (`intercom-bridge.ts`, `IntercomEventBus`, the marker string) and CHANGELOG history. No runtime tool, event, or config field named `intercom` remains.
- `IntercomParamsSchema` inside `native-supervisor-channel.ts` describes the `subagent_supervisor` tool parameters.

## 2. Removed per-agent persistent memory

The `memory` frontmatter field is gone. Agents can no longer opt into role-specific `MEMORY.md` scopes; the `agent-memory/` namespace is no longer read or written.

### Removed

- `memory` frontmatter field and `AgentMemoryConfig` / `AgentMemoryScope` types.
- `src/agents/agent-memory.ts` (`parseMemoryFrontmatter`, `agentHasWriteTools`, `resolveMemoryDir`, `readMemoryFile`, `buildAgentMemoryInjection`).
- Memory block injection into child system prompts (foreground, async chain steps, async runner, preflight).
- `memory` field from the async recovery descriptor (write, validation, allowed-field list, resume mapping).
- `memory` from `projectAgentDefinition`, so it no longer affects agent digests.
- `Memory: ...` line in agent management detail output.
- Serialization of `memory:` in `serializeAgent`.

### Kept

- `"memory"` remains in `KNOWN_FIELDS` (agent-serializer) so leftover `memory:` frontmatter is silently ignored instead of round-tripping as an unknown field.

### Where

- Deleted: `src/agents/agent-memory.ts`, `test/unit/agent-memory.test.ts`.
- Touched: `src/agents/{agents,agent-serializer,agent-management}.ts`, `src/shared/launch-contract.ts`, `src/api/preflight.ts`, `src/runs/foreground/execution.ts`, `src/runs/background/{async-execution,async-resume}.ts`, `test/unit/steering.test.ts`, `README.md`, `skills/pi-subagents/references/management-authoring-rpc.md`.

### Notes

- Existing `memory:` frontmatter in user agent files is ignored, no migration needed.
- Existing `agent-memory/` directories become inert leftovers, never read.

