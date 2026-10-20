# Nightpulse · 夜脉

[中文](README.zh-CN.md) · English

**Autonomous wakes with a thread back to the main conversation.**

Nightpulse lets a Claude Code agent wake in a disposable fork, continue an
interest or unfinished task within configured permissions, and leave a bounded
record for the next main-conversation turn. A wake may act, prepare a handoff,
or remain silent.

This project is a fork of [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss).
Cyberboss provides the underlying chat bridge, runtime adapters, random check-ins,
reminders, diary, and timeline capabilities. Nightpulse's additions focus on
isolated wakes and continuity between those wakes and the main conversation.

## What Nightpulse adds

| Component | Behavior |
| --- | --- |
| Isolated wake | Forks an existing bound Claude Code session without rebinding the main conversation or persisting a separate fork transcript. |
| Continuity state | Keeps small records of interests and unfinished directions across wakes. Empty updates preserve existing state. |
| Action receipts | Records paired tool calls and recognized successful results as they happen, including work completed before a later timeout or invalid final response. |
| Main-session return | Appends a bounded receipt packet to a later main input; acknowledges it only after successful main-turn completion. |
| Recent-read index | Tracks actual returned floors and content for Garden-style post reads, helping avoid repeated full reads without a reason. |
| Result handling | Rejects recognized confirmation-required responses as completed actions and terminates malformed JSON parsing without an infinite loop. |

The flow is:

```text
Existing main session
        |
  scheduled wake
        |
  disposable fork --> permitted tools
        |                    |
  optional summary     paired tool facts
        +--------------------+
                   |
          private local receipts
                   |
       next main input + receipts
                   |
      successful completion: acknowledge
      failure/cancellation: retain for retry
```

The fork's full conversation is not merged into the main transcript. Receipts
carry compact evidence and an optional labelled self summary; they do not
promise that a model will interpret or retain every detail.

## Current scope

The new isolated-wake path supports **Claude Code** and is **opt-in**. Existing
Codex support and normal check-ins remain inherited from Cyberboss. The shared
codebase currently retains the upstream **WeChat bridge**; a separate private
Telegram deployment is not part of this release.

Nightpulse does not replace a memory database. An existing memory service can
remain connected through its normal MCP/API interface. This repository contains
program code and synthetic test fixtures, not personal memories or a running
agent's private configuration.

## Get the code

Requirements: Node.js 22 or newer, Git, and a locally installed Claude Code CLI
for the isolated-wake path. Complete the CLI's normal account setup separately.

```sh
git clone --branch codex/autonomous-wake --single-branch https://github.com/huk38786-max/nightpulse.git
cd nightpulse
npm install
```

The package, commands, tool names, environment-variable prefix, and default state
directory still use `cyberboss` for compatibility. The repository and project
name are Nightpulse.

## Enable isolated wakes

Set up the inherited bridge and bind an existing main Claude session first.
The [command reference](docs/commands.md) describes the bridge entrypoints;
[upstream documentation](https://github.com/WenXiaoWendy/cyberboss) provides its
original setup guide.

Add the following to your own existing local configuration, without replacing
its account and workspace settings:

```dotenv
CYBERBOSS_RUNTIME=claudecode
CYBERBOSS_ENABLE_CHECKIN=1
CYBERBOSS_ISOLATED_CHECKIN=1
CYBERBOSS_ISOLATED_CHECKIN_TIMEOUT_MS=300000
CYBERBOSS_ISOLATED_CHECKIN_ALLOWED_TOOLS=mcp__example__read_item
```

The tool name above is a placeholder. Supply the exact MCP names you have
reviewed for your deployment. The bridge handles permission requests for
`ToolSearch` and configured MCP tools; standing user permissions still apply.
Actions requiring review should return a handoff or a complete draft.

This permission handler is not an operating-system sandbox. Tools already
approved by CLI settings may bypass a bridge permission request, so review the
CLI's existing permissions too. Do not use permission-bypass flags.

Restart through your normal bridge lifecycle after changing configuration.
Use `/checkin <min>-<max>` to adjust the random interval. The isolated path
requires an existing parent session and will not create one automatically.

For configuration, data retention, and acknowledgement details, see
[Isolated autonomous wakes](docs/autonomous-wakes.md).

## Data and limits

- Local continuity state and receipts are private runtime data. Do not commit
  them, transcripts, diaries, credentials, or deployment environment files.
- Tool facts and the fork's own account are labelled separately. A successful
  tool return does not prove delivery, publication, or another person's reading.
- The read index provides context, not proof that a remote post is unchanged.
- Forking does not guarantee cache renewal or lower quota consumption. Prefix
  differences, CLI behavior, cache expiry, and output all affect usage.
- Tests use synthetic data and fake CLI processes. There are no borrowed chat
  screenshots presented as Nightpulse demonstrations.

## Checks

```sh
npm run test:autonomous
npm run check
node --test test/*.test.js
```

The full suite has four known upstream sticker-test failures on machines without
the original author's hard-coded fixture path. These were reproduced on the
unmodified upstream baseline; see the corresponding test output when evaluating
changes.

## Source and license

Based on [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss).
The upstream license and copyright notices are preserved. Nightpulse's wake
additions and this documentation remain under [AGPL-3.0-only](LICENSE).
README rewritten on 2026-10-20 to describe this fork's actual scope.
