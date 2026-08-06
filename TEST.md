# Manual Test — Persistent Subagent (permanent channels)

Dev build of `pi-subagents` with the permanent-channels persistent chat.
After any code change, reload the extension in pi: `/reload`.

## What it does

- All `slotCount` channels (default 3) exist from startup; nothing spawns, nothing
  closes. Channel numbers are stable: `persist-1`, `persist-2`, `persist-3`.
- **State is scoped per main-agent session**: channels + session files live
  under `sessions/<mainSessionId>/` next to the extension. Restarting the same
  pi session restores its channels; a brand-new pi session starts with 3 empty
  channels.
- `alt+n` (Option-as-Meta on macOS Terminal) cycles the input target:
  `🔊 0` (main) → `🔊 1` → `🔊 2` → `🔊 3` → `🔊 0` → …
- A channel gets a real session (and its `persist-N.jsonl` file) only at its
  FIRST routed prompt. Runs are backgrounded; main keeps working.
- Scoped commands while targeted: `/compact`, `/model [provider/model]`,
  `/name <name>`, `/new` (reset channel), `/clone` (main session as first prompt).
- Esc on an empty editor while targeted interrupts the current run; streaming
  output appears live in the box + fleet `Last output:`.

## Steps

1. `/reload` — startup log shows `pi-subagents` loaded without errors.

2. **Baseline**: type a normal prompt (e.g. `say hi`). Main responds. Footer `🔊 0`.

3. **Cycle to a channel**: press `alt+n` twice (→ `🔊 1`), then type `hello sub`.
   - A `persist.run` box appears (pending spinner, then ✓ success).
   - Main agent's LLM is not called for the subagent prompt.
   - `~/.pi/agent/extensions/pi-subagents/sessions/<mainSessionId>/persistent-sessions/persist-1.jsonl`
     now exists (only after the first prompt).

4. **Continue the conversation**: type `remember my name is Ada` — same session
   file resumes (both prompts present in `persist-1.jsonl`).

5. **Live streaming + interrupt**: give the subagent a long task; its box shows
   `⚙ <tool> — <args>` and growing output while it works. Press `Esc` on an
   empty editor → box turns red ✗ with "Interrupted. Waiting for explicit next
   action."

6. **Parallel tracks**: cycle to `🔊 2`, prompt it; back to `🔊 1` — each channel
   keeps its own conversation.

7. **/new reset**: target a channel that has a session, type `/new`.
   - Notification: channel reset; session file deleted; fleet shows the channel
     as "not started".
   - Next prompt starts a FRESH session file.
   - While a run is in flight: `/new` interrupts it, and the reset lands after
     the child stops (channel shows idle, old session gone).
   - On main (`🔊 0`), `/new` keeps pi's builtin behavior (fresh main session).
   - A `/model` choice survives `/new` (check with `/model` after reset).

8. **/clone**: target a channel with no session (`/new` first if needed), type
   `/clone` → "will start from a clone of the main session". First prompt
   resumes the fork (main's conversation up to the clone point).
   - `/clone` on a channel that already has a session warns (`/new` first).
   - `/clone` with no persisted main session warns.

9. **Scoped commands**: targeted at a subagent —
   - `/model anthropic/claude-sonnet-4` — subagent model set (not main's).
   - Bare `/model` — builtin model picker opens in place; Enter applies, Esc
     cancels.
   - `/name my-bot` — session renamed.
   - `/compact` — session compacts (token delta reported).
   - `/settings` on a subagent target runs on MAIN (passes through).

10. **Restart survival**: run a subagent prompt, quit pi, restart, `/reload`.
    - Restarting the SAME session: channels + session files restored; fleet
      shows the last output (rehydrated from the session tail). Type into the
      channel — the conversation resumes.
    - Starting a BRAND-NEW pi session: `sessions/<newId>/` does not exist —
      the fleet shows 3 empty channels; the old session's subagents are not
      visible (their files stay on disk under the old session's scope).
    - Main `/new` (builtin): fresh channels for the new main session.

11. **Fleet**: arrow-down with empty editor opens the fleet; `State`/`Slot`/
    session file/`Last output:` for all channels; `⇧M`/`⇧N` page-scroll the detail
    column. Esc closes it (Esc while the fleet is open must NOT interrupt a run).

## Known behavior

- The subagent is a real pi child: it inherits main's skills/extensions/tools,
  and the sandbox stays active inside it.
- While main is streaming, a routed prompt defers to the next turn boundary —
  you are never blocked, and box messages never steer an extra main turn.
- A restart does not carry run history into the fleet beyond `Last output:`.
