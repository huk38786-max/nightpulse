# Isolated autonomous wakes

Changes dated 2026-10-19. This optional feature extends Cyberboss's existing random
check-ins. It remains under the repository's AGPL-3.0-only license and preserves
the original project and license notices.

## What this adds

- A Claude Code wake resumes the existing main session using `--fork-session`,
  `--print`, and `--no-session-persistence`. It does not rebind the main session
  or merge the fork transcript into it.
- Small continuity state retains interests and unfinished directions across
  wakes. Empty updates preserve state; explicitly named fields can be cleared.
- Paired tool calls and successful results become local action receipts as they
  happen. Work completed before an invalid final JSON or later timeout survives.
- An optional 480-character account from the fork is labelled separately from
  tool-confirmed facts. Private reasoning is not retained by the fork runner.
- The next main input receives a bounded receipt packet appended after the new
  user message. No extra main-model turn is sent merely to announce a wake.
- Only successful main-turn completion acknowledges that exact packet. A failed
  send, cancellation, or CLI error leaves receipts available for a later turn.
- A recent Garden-style `get_thread` read index records actual returned reply
  floors and body-read status. Identical content with a changing view count does
  not create repeated facts. This guides rereading; it does not ban a deliberate
  revisit or prove that the remote thread is unchanged.
- Malformed final results terminate with an invalid-result outcome instead of
  trapping the bridge in the reverse JSON-candidate scan.

## Enable

Existing check-ins remain the default. For the optional Claude Code path, use
your own local environment file:

```dotenv
CYBERBOSS_RUNTIME=claudecode
CYBERBOSS_ENABLE_CHECKIN=1
CYBERBOSS_ISOLATED_CHECKIN=1
CYBERBOSS_ISOLATED_CHECKIN_TIMEOUT_MS=300000
CYBERBOSS_ISOLATED_CHECKIN_ALLOWED_TOOLS=mcp__example__read_item
```

Replace the example tool with exact MCP tool names that you have reviewed for
your deployment. The bridge's permission-request handler allows `ToolSearch`
and explicitly listed MCP tools. It denies unknown requests and named deletion
tools; shell and arbitrary file-mutation tools cannot be added through this list.
If a tool is not allowed, the fork can return a concrete handoff or a complete
draft for review instead of performing that action.

This is an application-level approval policy, not an operating-system sandbox.
CLI settings and tools already approved by the CLI may avoid a permission request
to the bridge. Review those settings too; do not use permission-bypass flags.
Standing user permissions and any requirement to review public posts still apply.
Changing this environment list does not grant consent on another user's behalf.

A main Claude session must already be bound. The isolated path refuses to invent
a parent session. The existing `/checkin <min>-<max>` command controls the random
interval. Codex and deployments without the isolated flag retain the original
main-session check-in path. Configuration changes require a normal app restart.

## Local data and acknowledgement

The normal state directory contains:

- `autonomous-state.json`: bounded continuity directions and progress markers.
- `autonomous-experiences.json`: receipts, read index, and per-main-session cursors.

Both stores use atomic writes with file mode 0600 and assume one writing bridge
process. Receipt scopes are separated by chat binding and workspace. A scope
retains 256 entries, up to 24 read threads with 500 reply floors each, and bounded
main-session cursors. Packets are about 3,200 characters plus a backlog notice.
Truncated history is labelled as a partial record; delivery may repeat after a
crash instead of silently skipping unacknowledged facts.

The ledger does not copy full tool arguments or authentication fields. Short
submitted-text excerpts and self summaries can contain personal information, so
the ledger remains private runtime data. Do not upload it, transcripts, diaries,
API keys, real test memories, or deployment environment files. Tests use synthetic
data, temporary state directories, and fake CLI processes.

An error envelope, denial, or recognized confirmation-required response does not
count as completed work. Other successful tool returns are labelled as tool
results, not proof of delivery, publication, another person's reading, or a
remote service's later state.

## Tests and boundaries

```sh
npm run test:autonomous
npm run check
```

The feature does not add or replace a memory database. An existing memory service
may remain connected through its normal MCP/API interface. It also does not add
Telegram, network egress enforcement, authentication changes, or private persona
prompts; these are separate concerns.

Forking can reuse an eligible main-session prefix, but there is no cache-renewal
guarantee. CLI versions, prefix changes, cache expiry, context length, and fresh
outputs affect usage. This feature makes no quota-saving claim. It does not
include the separate cache-observation journal or historical replay tooling.

## Optional recall hooks

The [automatic recall module](memory-recall.md) can be installed separately. The isolated Claude runner sets `NIGHTPULSE_ISOLATED_WAKE=1` on its child process so those hooks skip retrieval and local archiving in the disposable branch, including SessionStart. Main-session hooks continue normally. Action receipts travel through the bridge ledger, not through a replay of the fork transcript.
