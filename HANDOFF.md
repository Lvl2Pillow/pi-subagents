# HANDOFF — persistent subagents (pi-subagents)

Scope: the **persistent subagent** feature only (`src/persistent/*`, related bits in
`src/extension/index.ts`, `src/extension/config.ts`, `src/shared/types.ts`,
`src/tui/fleet.ts`, plus `test/{unit,e2e,integration}` for it). The rest of the
extension (subagent tool, runs pipeline, watchdog, intercom) is out of scope here.

## 1. Spec (product)

### Purpose

Persistent subagents are up to `slotCount` (default 3, configurable 1–8)
long-lived background agents you can talk to while the main agent keeps
working. Each pi session is its own world — one main agent + its channels.
Channels keep their own context and transcript across pi restarts _of the
same main-agent session_, so a session's channels carry a task or a role for
days without diluting main's context — while a brand-new pi session starts
with clean channels and never sees another session's subagents.

### Use cases

1. **Fire-and-forget long tasks** — hand a subagent a big job, keep working with
   main immediately, check the result later. Example: "research X, write up
   your findings" while main keeps answering your questions.
2. **Dedicated roles with stable context** — a research agent, a code-review
   agent, a docs agent, each accumulating its own memory over many sessions
   without polluting main's context window.
3. **Context isolation** — main's compaction never touches a subagent's context
   and vice versa; each agent only pays for the context it needs.
4. **Parallel tracks** — several subagents run different threads concurrently;
   main orchestrates. Example: two subagents explore two solutions to one
   problem while main coordinates.

### Functionality & UX

**Input routing — `alt+n`**

- `alt+n` cycles the input target: main (0) → channel 1 → … → channel N →
  main (wrapping). On macOS Terminal this is Option-as-Meta.
- The footer shows `🔊 N` for the current target. It updates on switch only — it
  is a target indicator, not a run-status readout.
- Whatever you type goes to the targeted agent. Switching away from a subagent
  and back leaves its conversation exactly where you left it; main's input is
  unaffected while a subagent is targeted.
- Shortcut is configurable (`persistentChat.switchShortcut`, default `alt+n`).

**Channels (always present, never closed; scoped per main session)**

- All `slotCount` channels exist from startup — there is no spawn step and no
  close step. Channel numbers are stable identities (`persist-1` …).
- **Session scoping**: all persistent state (the channel table and the
  channel session files) lives under `sessions/<mainSessionId>/` next to the
  extension. The scope key is the MAIN agent's session id
  (`ctx.sessionManager.getSessionId()`):
  - Continuing/resuming the same main session → same id → its channels come
    back (restart survival).
  - A brand-new pi session (new id), main `/new`, or a main fork → fresh
    channels; nothing leaks from other sessions. Old scopes stay on disk.
  - A channel has no session until its FIRST routed prompt; the first prompt
    lazily creates `sessions/<mainSessionId>/persistent-sessions/persist-N.jsonl`.
  - The debug log is scoped too (`sessions/<mainSessionId>/logs/`).
- `/new` (while targeted) resets the channel: drops its queued prompts,
  interrupts the current run if one is in flight (like Esc), deletes the
  session file, and clears the channel back to its pre-session state. The
  channel's `/model` choice survives `/new`; on main, `/new` passes through to
  pi's builtin (fresh main session + fresh channel scope).
- `/clone` (while targeted, before the channel's first prompt) clones the
  current MAIN session as the channel's starting conversation — the fork
  happens at `/clone` time, so the channel starts from that snapshot. Warns
  when the channel already has a session (`/new` first) or when main has no
  persisted session to fork. On main, `/clone` passes through to pi's builtin.

**Background execution**

- A prompt routed to a subagent runs in the background: main keeps accepting
  input immediately and keeps streaming its own work. You are never blocked on
  a subagent's run.
- One run per subagent at a time; extra prompts queue in order and run when the
  slot frees up.
- Subagents inherit main's skills, extensions, and tools; sandbox and trust
  rules still apply to them.
- **Live streaming**: the subagent's progress streams as it works — every
  assistant message and tool event appears in the run's chat box (grow while
  expanded) and in the fleet's `Last output:` panel, with a live
  `⚙ <tool> — <args>` line and a running `(N tools, M tokens)` counter. No
  waiting for the final result.
- **Restart survival**: restarting the SAME main-agent session (same session
  id) restores its channels — subagents themselves persist, and so does each
  slot's `Last output:` — on startup the fleet rehydrates it by reading the
  tail of the slot's on-disk session file (the last assistant message). A
  brand-new pi session starts with clean channels. Only the last output is
  rehydrated; nothing else about the run state is carried over.
- **Stop a subagent turn**: `Esc` on an empty editor while input targets a
  subagent interrupts its current run (same as main's Esc-to-abort; the box
  finalizes as a red failure with "Interrupted. Waiting for explicit next
  action."). If the prompt is still queued, Esc cancels it before it starts. Esc passes through
  while an overlay (fleet, model picker) is open so it still closes the
  overlay.

**Result boxes**

- Every routed prompt renders as a box in the chat: pending → in-place ✓
  success / ✗ failure.
- Collapsed to 1 line by default (`persistentChat.maxCollapsedLines`); `ctrl+o`
  expands; a dim `… (ctrl+o to expand)` hint shows when content is truncated.
- Boxes survive pi restarts — the transcript and its final status come back
  with the session.

**Scoped commands (while targeted at a subagent)**

When input is routed to a subagent, five `/` commands act on that subagent
instead of on main:

- `/compact [instructions]` — shrinks the subagent's context window so it
  frees tokens and keeps working reliably on long tasks. Optional instructions
  steer what the summary keeps ("keep the API details, drop the back-and-
  forth").
- `/model <provider/model>` — switches the subagent's model. With an argument
  it applies immediately; bare `/model` opens the same model picker as main
  (search, scrolling, provider badges, login hints) — Enter applies, Esc
  cancels. The choice persists across restarts and applies to that subagent's
  future runs. It never changes main's model or the global default.
- `/name <name>` — renames the subagent's session.
- `/new` — resets the channel (see Channels above).
- `/clone` — clones the main session as the channel's first-prompt session
  (see Channels above).

Scope rules and edge behavior:

- Everything else passes through unchanged: commands that affect shared/global
  state (`/settings`, `/login`, `/trust`, …) run on main as usual; commands
  tied to main's session (`/new`, `/resume`, `/tree`, …) pass through on main
  and are intercepted only while a subagent is targeted; extension commands
  stay main-level.
- **Busy slot** — while a subagent is mid-run, `/compact` and `/name` are
  refused with a notice; `/model` still saves the choice and it takes effect
  from the next prompt; `/new` interrupts the run and applies the reset once
  the child stops (never truncates a session file a live child is writing).
- **No session yet** — `/compact` and `/name` notify that there is nothing to
  act on; `/model` still stores the choice for the first prompt; `/clone` is
  only allowed here (first-prompt-only).

**Fleet view**

- Open from the fleet status footer widget (arrow-down with an empty editor):
  a table of all persistent channels with `State` (idle/running/success/fail),
  `Slot`, session file, and the last output/error once a run completes.
  Refreshes while open.
- Navigation: `↑↓/jk` move between agents; the right-hand detail column
  scrolls with `⇧K/⇧J` (line), `⇧M/⇧N` or `PgUp/PgDn` (page) — the shift+letter
  page keys exist because macOS Terminal has no usable PgUp/PgDn (fn+arrows
  scroll the terminal itself, and shift+space/arrows are indistinguishable
  from the unmodified keys there). Keys are listed in the overlay's footer.
- The detail panel notes that channels reset with `/new` and clone with
  `/clone` (before the first prompt).

**Restart survival**

- Subagents, their transcripts, the input target, and each subagent's model
  choice persist across pi restarts.
- Run state (`lastState`/`lastOutput`) is session-only and does not survive a
  restart.

### Config (`persistentChat` in config.json)

- `switchShortcut?: string` — default `"alt+n"`, validated non-empty string.
- `maxCollapsedLines?: number` — default 1, validated positive integer (throws
  on load if invalid).
- `slotCount?: number` — default 3, validated integer 1–8 (throws on load if
  invalid). Number of always-present channels.

## 2. Task list

### Done

- C1: alt+n cycle, `🔊 N` footer target status, stub echo subagent, `/persist`,
  `/close-subagent [n]`, disk persistence across pi restarts.
- C2: lazy spawn (session at first prompt), `clone`/`default` modes, tool-message
  UI (pending → success/fail in place, expand, tool styling), fleet entries, full
  main-agent inheritance, sandbox active in child. RED-GREEN tests throughout.
- **Per-main-session scoping**: persistent state moved under
  `sessions/<mainSessionId>/` (resolver in `session-scope.ts`,
  `resolvePersistentStateRoot`). State loads at `session_start` (bindSession),
  not register time — the id is only known then. A fresh session writes
  nothing; switching sessions silently resets the store (`replace(..., false)`)
  so channels never leak across sessions within one process. Debug log is
  session-scoped via `setPersistentLogRoot`. e2e harness accepts `sessionId`
  (fixed id via `SessionManager.create` newSessionOptions); two new e2e tests:
  leak isolation (session B never sees session A's channels) and restart
  survival (same id restores the channel). Pre-scoping legacy state at the
  extension root (`persistent-state.json`, `persistent-sessions/`) is left
  untouched on disk and no longer loaded.
- Debug logging (JSONL, best-effort) + `session_compact` listener to catch the
  compaction-collision window.
- **Turn-boundary launch**: flush queued runs at `turn_end` (`allowWhileStreaming`)
  instead of `agent_settled` — matches pi steering semantics.
- **Deferred box messages**: `drainDeferredMessageSends` — box sends wait for idle
  so they never steer an extra model turn.
- Tests: `test/integration/persistent-runner.test.ts` (4 tests, mock-pi children:
  defer while streaming, idle-only guard, turn-boundary launch, idle launch);
  e2e defer test (deferral + non-blocking + turn-boundary ordering); unit tests for
  store/routing/status/render/log/spawn/fleet.
- Test isolation: `test/support/isolate-state-dir.ts` + `PI_SUBAGENTS_STATE_DIR`
  wiring in every test that loads the extension (unit: index-child-registration,
  chain-validation, tool-description; integration: single-execution;
  e2e: persistent-chat, repro-compaction-reload, real-session-subagent). All suites
  leave zero trace at the real extension root.
- **Scoped slash commands for the active agent**: `/compact`, `/model` (with arg +
  bare builtin model picker), `/name` run against the active subagent via
  Enter interception (`ctx.ui.onTerminalInput`) + `scripts/persist-command.mjs`
  command child. `PersistentAgentEntry.model?` override persisted + passed as
  `modelOverride` on every spawn. Unit (18) + integration (8 incl. real-script
  session-file rename) tests; tsc/eslint/prettier clean.
- **Live streaming**: `runSync` `onUpdate` → `setPersistentRunLive` (pending box
  text grows) + `store.setRunOutput` (fleet `Last output:` live) + throttled
  status-tickle render (`ctx.ui.setStatus` forces a TUI re-render).
  `formatLiveProgress` composes `⚙ tool — args` + recent-output tail + counters.
- **Esc-to-interrupt**: per-slot `AbortController` → `interruptSignal` (SIGINT,
  mirrors main's "Interrupted." flow); `interruptPersistentRun` + queued-prompt
  cancel; wired in the terminal-input handler (target≠0, empty editor, no
  extension overlay open → consume). Integration tests: mock child `steps` for
  live chunks, long-delay child + interrupt, queued-prompt cancel.
- **Last-output restore on startup**: `session-read.ts`
  (`readLastOutputFromSessionFile` / `restoreLastOutputsFromSessions`) reads the
  last assistant text from each slot's session JSONL and rehydrates the fleet
  `Last output:` after pi restarts; runs before the persistence listener
  attaches, so no state-file write. 9 unit tests.
- **Permanent channels redesign**: slots became always-present channels —
  configurable `persistentChat.slotCount` (1–8, default 3; store constructor
  param, `replace()` pads/truncates on load, `clampSlotCount`); `spawn`/
  `closeTarget`/`closeByIndex` removed; `cycle` is a plain 0..N wrap;
  `PersistentMode`/`mode`/`resolvePersistMode` deleted (state format stays v2,
  legacy `mode` tolerated on load and ignored); fleet `Mode:` column and detail
  line removed.
- **`/new` channel reset**: scoped on subagent targets (passes through on
  main). `runner.resetChannelSession` — drops queued prompts; idle → deletes
  the session file + `store.resetChannel` (keeps id/index/model); busy →
  `pendingChannelResets` + `interruptPersistentRun` (run controller, or SIGINT
  for a command child via the new `commandChildren` map), and the reset is
  applied from the run/command finalize path AFTER the child stops, so a dying
  child can never write into a truncated session file.
- **`/clone` command**: scoped on subagent targets (passes through on main's
  builtin duplicate-session). `runner.cloneMainSessionToChannel` — allowed only
  while `sessionFile === null` (first-prompt-only; `/new` re-allows it); forks
  the main session via `createForkContextResolver` and stores the fork as the
  channel's session.
- Tests: unit — store rewrite (pre-created channels, `resetChannel`, `replace`
  padding/truncation, slot-count clamp), `classifyScopedCommand` now covers
  `/new`+`/clone`; integration — `resetChannelSession` idle/busy/queued-drop
  and `cloneMainSessionToChannel` success/already-has-session/no-parent-session
  (+6 net); e2e — persistent-chat rewritten to startup-channels + isolation +
  startup-restore smoke (routing needs alt+n, unreachable via `session.prompt`),
  repro-compaction-reload now targets channels by invoking the alt+n shortcut
  handler (3 channels → 0→1→2→3→0 cycle).

### Open / not done

- **Bug 1 (monitored, root cause not in the extension):** after a main-session
  auto-compaction, alt+n sometimes stops switching / input can't return to main.
  Reconstructed the 17:25 incident: queued-input collision during compaction
  (prompt routed fine, run completed) — no extension-level bug found in pi 0.83.0
  static analysis; recovery = full pi restart. The `session_compact` log entries
  should capture the exact window next time.
- **Busy-guard (implemented 2026-08-07):** double-Enter during a child run used to
  spawn two concurrent `runSync` on the same session file → contention/lost context.
  In-process `runningSlots` blocks same-process overlap; cross-process exclusivity
  (stale child from a previous pi process, or a second pi instance) is now enforced
  with upstream's `acquireSessionLease` per slot — acquired before spawning the run
  or command child, released on finalize and on `session_shutdown`. A live foreign
  lease fails the launch with "Another process still owns this channel's session."
- `lastOutput`/`lastState` don't survive restart (documented limitation).

## 3. Pitfalls (actual problems hit & resolved)

1. **`run.modelCalls` is a snapshot** — the harness captures `faux.state.callCount`
   when `runRealSubagentSession` returns, so main turns submitted after that are
   invisible to it (3 LLM calls logged, count still read 1). Fixed the e2e test to
   count assistant messages instead (subagent output never creates parent assistant
   messages).
2. **After routing, target = 1** — a naive "slow main turn" in the e2e test got
   routed to the subagent instead of streaming on main. Tests must cycle with the
   real `alt+n` handler via `extensionRunner.getShortcuts().get("alt+n")`. With
   the default 3 channels the cycle is 0→1→2→3→0, so returning to main from
   channel 1 takes three presses.
3. **`pi.sendMessage` while streaming = steer.** The pending box sent at `turn_end`
   was queued into the steering queue → the agent loop streamed an extra model turn
   for an empty custom message (visible as a 4th assistant message / empty "user").
   Root-caused with LLM-call instrumentation. Fixed with deferred box sends
   (`drainDeferredMessageSends`).
4. **`agent_settled` ≠ turn boundary.** It fires only after the whole run incl.
   retries/continuations; steering injects at `turn_end`. The original deferral was
   therefore "task done" timing, not "turn done". Switched the flush trigger.
5. **Module-level queue leaked across tests in one file** — the integration test ran
   3 child spawns for 1 enqueue (previous tests left `queuedPrompts` entries).
   Fixed with `setPersistentRunnerActive(false); setPersistentRunnerActive(true)`
   in `beforeEach`.
6. **Test runs wrote `logs/persistent.log` to the real extension root** — the
   logging feature writes at register time; several pre-existing tests
   (`registerSubagentExtension`) had no state-dir isolation, and
   `real-session-subagent.test.ts` set none at all. Added
   `test/support/isolate-state-dir.ts` and wired `PI_SUBAGENTS_STATE_DIR` into every
   test that loads the extension. Integration suites also must run with
   `--import ./test/support/register-loader.mjs` (missing it earlier produced 8
   false "failures" — the ts-loader shim mocks `keyText`/pi-tui only for imports
   whose parent URL ends with `/render.ts`).
7. **Env-less debug scripts wrote to the REAL user state** — a debug script without
   `PI_SUBAGENTS_STATE_DIR` spawned persist-2/3 at the extension root, appended
   debug prompts to the real `persist-1.jsonl` (12 → 141 lines), and rewrote
   `persistent-state.json`. Restored: truncated the session back to its original 12
   entries (verified intact), deleted persist-2/3, rebuilt the state file
   (persist-1, target 0). Rule: any ad-hoc script touching the extension must set
   `PI_SUBAGENTS_STATE_DIR` first.
8. **Env-var timing with ES imports**: `process.env.PI_SUBAGENTS_STATE_DIR` set in a
   script's body does apply to the extension (it loads at runtime inside the
   harness), but the register.ts `STATE_ROOT` const is captured at module load — so
   log _line content_ (stateFile field) can show the real path even when the file is
   isolated; the _file location_ follows the write-time env. Don't rely on log-line
   paths for isolation checks.
9. **`state.callCount` inside the faux `respond` is authoritative** (increments
   before the step runs), while `faux.state.callCount` read later is the same object
   — the earlier confusion was the snapshot in (1), not a second provider instance.
10. **e2e ordering assertions were racy** (e.g. `pendingIdx > lastAssistant` across
    a multi-turn race). Rewrote with deterministic checks: zero `persist.run`
    messages while streaming, `submitMs < 800` for non-blocking proof, pending index
    > the streaming turn's assistant index.
11. **`--experimental-strip-types` rejects constructor parameter properties.** The
    model-picker component initially used `constructor(private readonly tui …)` —
    every extension-loading unit test then crashed with
    `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Converted to explicit field declarations.
12. **Shell `${\...}` inside a TS template literal is parsed as interpolation.** The
    mock command-binary script used `${options.exitCode:-0}` — `:-0` broke TS
    parsing. Interpolate the value as `${options.exitCode ?? 0}` instead; escaped
    `\${...}` would have reached the shell as a literal parameter expansion.
13. **Node strip-only also forbids TS-only syntax in `.mjs`.** An `export interface`
    leaked into `scripts/persist-command.mjs` → `Unexpected token 'export'` on
    import. Kept the script plain JS (typed via the test's loadScript casts).
14. **`run.modelCalls`-style snapshot trap in the busy-guard test.** The mock pi
    child finished faster than the assertion, so `runningSlots` was already free and
    the command was NOT refused. Made the child slow (`delay: 1000`) so the guard is
    deterministic, then waited for completion before teardown.
15. **Session files buffer entries until the first assistant message.** Hand-crafting
    a session file for the real-script test needs a session header + user +
    assistant message, or the rename append is buffered (`flushed=false`) and never
    hits disk.
16. **Custom pickers reimplement what the builtin already does.** The first
    subagent picker was a hand-rolled list capped at ~20 visible rows with no
    scrolling → models past the cap were unreachable. Switched to pi's exported
    `ModelSelectorComponent` with adapter objects (`ModelRuntime` facade over
    `ctx.modelRegistry`; no-op `SettingsManager` to avoid clobbering the global
    default). Its `close()` is private and its refresh resolves near-instantly, so
    no dispose hook is needed.
17. **Permanent channels changed the e2e targeting surface.** `/persist` was the
    only harness-reachable way to target a subagent (the harness drives
    `session.prompt` only, no key injection). With channels always present, the
    alt+n shortcut handler (`extensionRunner.getShortcuts().get("alt+n")`) is
    reachable, so regression e2e targets via handler calls; routing semantics stay
    unit/integration-covered.
18. **Store target starts at 0** — the old `spawn()` auto-targeted the new slot;
    pre-created channels do not, so integration tests that enqueue prompts must
    `store.setTarget(1)` first (a missing target silently no-ops the enqueue).
19. **Out-of-range `replace` target clamps to the last channel, not 0** — every
    channel is always occupied, so `Math.min(target, slotCount)` lands on a valid
    channel; only negative targets fall back to main.
20. **State loads at session_start, not register time** — the session id is
    unknown at extension-register time. `bindSession` runs on every
    `session_start` (startup/reload/resume/new/fork), resolves the scoped root,
    and repopulates the store. First bind with no on-disk state is a strict
    no-op (the store is already fresh and a write would break the e2e clean-boot
    contract); later binds on a session switch reset silently
    (`store.replace([], 0, false)`).
21. **A session-scoped log write happens at every session_start** (index.ts logs
    the start reason), so the scope directory exists after boot even when no
    channel state was written. e2e assertions check for `persistent-state.json`
    and `persistent-sessions/`, not for the scope dir itself.
22. **The old global root is orphaned, not migrated** — legacy
    `persistent-state.json` + `persistent-sessions/` at the extension root were
    written by the pre-scoping code and have no main-session linkage, so a
    one-time auto-migration could not tell which session owned them (and would
    re-import another session's subagents into a brand-new session). They are
    left on disk untouched and no longer loaded.
