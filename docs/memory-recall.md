# Automatic recall and compaction continuity

Nightpulse's optional Claude Code hooks connect the current conversation to a separately deployed [Ombre Brain](https://github.com/P0luz/Ombre-Brain) memory service. The hooks decide **when to retrieve, how much to return, and how to label the evidence**. Vector search, graph retrieval, embeddings and backend ranking belong to Ombre Brain; this repository does not reimplement them.

The portable module is extracted from a personal deployment on 2026-10-20. It shares executable policy and synthetic fixtures, without that deployment's memories, persona, account details, endpoints or credentials. It has not been installed into any existing personal workspace by publishing it.

## Behavior

| Event | Behavior |
| --- | --- |
| Ordinary user message | Request a small `breath` result, up to 350 backend tokens and 3 results. Render a lightweight index, limited to 900 characters. Short acknowledgements are skipped; short topical messages are eligible. |
| Explicit memory question | Request up to 700 backend tokens. Render bounded source excerpts instead of only an index. Corrections or failed explicit retrieval can also read local dialogue evidence. |
| Self-wake | `SYSTEM ACTION MODE:` prompts skip ordinary topic retrieval. Optional fresh Timeline facts can supplement them. Isolated wake children carry `NIGHTPULSE_ISOLATED_WAKE=1`; these hooks return without retrieval or local archiving, including at SessionStart. The branch still inherits its fork context and bridge receipts. |
| Before compaction | Index visible text from the supplied transcript and checkpoint the last 16 indexed user/assistant messages. No model call or remote write. |
| After compaction | Save the actual CLI compaction summary separately as derived text. It is not promoted to a user fact or included in the default quotation fallback. |
| Resume / after compaction | Retrieve a bounded `breath(mode="handoff")` capsule and supplement it with local quotations. A hook attachment marker suppresses repeat capsules within the observed compaction epoch. |

The known bridge envelope and appended action receipt block are excluded from the recall query and archived user speech. User-written dates remain intact. Historical excerpts retain dates and attribution; assistant claims and later user corrections stay distinguishable. Dreams and random resurfacing are excluded from direct evidence rendering.

This is automatic retrieval at a hook boundary. The agent may still need a targeted MCP read for exact details. Automatic recall does not mean every memory is inserted on every turn.

## Requirements

- Python 3.10+ with standard-library SSL, SQLite and timezone data; macOS or Linux (`fcntl` is used for local locking).
- Claude Code with command hooks for `SessionStart`, `UserPromptSubmit`, `PreCompact` and `PostCompact`. See the [official hook reference](https://code.claude.com/docs/en/hooks). Older CLI versions may lack an event; check compatibility before merging settings.
- For remote recall: an independently deployed Ombre Brain HTTP MCP endpoint exposing `breath`, and optionally `darkroom_search`. Not every memory server supports this schema.

These are command hooks, not prompt hooks. They do not start an additional Claude chat-model request to summarize or search. Backend embeddings, retrieval or processing can still have their own costs. All injected text also occupies the main conversation's context.

## Installation

Copy the entire module directory into the workspace where Claude Code runs:

```sh
mkdir -p /path/to/your-workspace/.claude/hooks
cp -R hooks/nightpulse /path/to/your-workspace/.claude/hooks/nightpulse
```

Merge the following `hooks` entries into that workspace's existing `.claude/settings.json`. Preserve existing hooks and permissions; do not replace the whole settings file. If you already have equivalent recall hooks, choose one implementation to avoid duplicate retrieval. The example uses `python3`; use the absolute path of a working Python interpreter if your launcher does not provide it.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "resume|compact",
        "hooks": [{
          "type": "command",
          "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/nightpulse/memory_recall.py\"",
          "timeout": 50
        }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/nightpulse/memory_recall.py\"",
          "timeout": 50
        }]
      }
    ],
    "PreCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/nightpulse/memory_continuity.py\"",
          "timeout": 20
        }]
      }
    ],
    "PostCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/nightpulse/memory_continuity.py\"",
          "timeout": 20
        }]
      }
    ]
  }
}
```

Provide the following through your own launch environment. The Python module does **not** automatically load a `.env` file. Restart through your normal lifecycle when necessary for changed registrations or environment to take effect.

| Variable | Default / purpose |
| --- | --- |
| `NIGHTPULSE_OB_MCP_URL` | No default. Your read-enabled HTTP MCP endpoint. Never commit the real URL if it embeds credentials. |
| `NIGHTPULSE_OB_MCP_TOKEN` | Optional Bearer token, sent only in headers. Use HTTPS, or loopback HTTP for local development. |
| `NIGHTPULSE_OB_MCP_FALLBACK_URL` | Optional explicitly trusted backup for the **same memory store**. No built-in fallback address. |
| `NIGHTPULSE_TIMEZONE` | `UTC`; set an IANA timezone such as `Asia/Shanghai` for displayed current time and Timeline validation. |
| `NIGHTPULSE_RECALL_STATE_DIR` | Base state directory. Default: `$CYBERBOSS_STATE_DIR/recall-hooks`, or `~/.cyberboss/recall-hooks` when unset. A workspace hash subdirectory is appended. Keep this outside Git. |
| `NIGHTPULSE_DARKROOM_RECALL` | `0`. Explicitly set `1` only if private-room retrieval is wanted and the server supports it. |
| `NIGHTPULSE_TIMELINE_PATH` | Unset. Optional local Timeline JSON file; no file is read when absent. |

Do not set `NIGHTPULSE_ISOLATED_WAKE` in the main launch environment. Nightpulse's isolated runner sets it only on the disposable child. Other launchers must set it themselves when running an isolated wake.

Timeline supplementation expects `timezone`, `facts[YYYY-MM-DD].updatedAt` and an `events` array with `title`, `startAt`, optional `endAt`. The timezone must match configuration; updates older than six hours are rejected, and ended events are considered only for four hours.

## Transport and failure behavior

The client only calls the read tools `breath` and optional `darkroom_search`. It initializes a fresh MCP HTTP session per tool read, supports stateless responses and session IDs, and accepts JSON or SSE. A matching SSE result returns without waiting for stream closure. There is a shared 40-second remote-call budget, a shorter 10-second Darkroom budget, and a 2 MiB response cap. Local indexing happens outside the remote budget and is separately bounded.

An explicitly configured fallback can be tried after transport failure or HTTP 502/503/504, within the same budget. HTTP 401/403, redirects and invalid protocol responses do not switch endpoints. Redirects are disabled. Ambient proxy environment variables are ignored for this configured memory endpoint; deploy it at an address this process can reach directly. This client is separate from the Claude API network path and does not implement that path's IP controls.

A retrieval failure is labeled as a failure, not as proof that no memory exists. The hook returns exit code 0 on handled errors so it does not block the conversation. Logs contain stage, exception type, elapsed time and optional HTTP status; they omit queries, memories, endpoint URLs and tokens.

## Local evidence and limitations

Only the transcript path supplied to the current hook is read. The module does not scan other projects, modify transcripts, archive thinking/tool-result bodies, upload a transcript, or write to Ombre Brain. Explicit topic queries and handoff session IDs are sent to the configured backend for retrieval.

The SQLite index stores visible dialogue text, role, timestamp, session/message IDs, byte offset and SHA-256 of the original record. These references identify indexed source records; this module does not provide a full transcript backup or automatically revalidate an old record against a rewritten source. Basic secret-pattern redaction is best effort, not a guarantee that all sensitive prose is removed. Treat the entire state directory as private.

Each indexing pass considers at most 4 MiB of dialogue data. If the initial transcript or an unread backlog exceeds that limit, the pass starts near its end so a checkpoint favors recent dialogue; older unindexed records are omitted. Malformed or oversized records may be skipped. A partial appended line is retried. Rotation, truncation and an anchor mismatch cause the file to be reconsidered; already indexed message IDs are retained, not overwritten. Local quotations therefore have partial historical coverage. State grows over time; retention/deletion remains the operator's responsibility. Deleting a workspace's hook state removes this local evidence index, not the original transcript or backend memories.

Workspace state directories use mode 0700 and index/lock files use 0600. Local quotation search spans indexed sessions within that workspace; it is keyword matching, not a second vector database. It excludes the currently submitted user record when that record is already present in the transcript. Compaction capsules are bounded context, not a guarantee of exact or permanent recollection. Epoch deduplication inspects only the final 4 MiB and depends on the CLI recording hook attachments; a capsule can repeat when that evidence is unavailable.

The portable module does not include personal alias rules, persona, private service mirrors, automatic memory writing, Graphiti, Telegram, IP allowlists or account configuration. The separate [autonomous wake layer](autonomous-wakes.md) returns branch actions through its own receipt ledger. Hooks, source checkpoints and receipts complement one another; none guarantees prompt-cache hits or a fixed subscription quota cost.

## Verification

```sh
npm run test:recall
npm run test:autonomous
npm run check
```

Python tests use synthetic transcripts, fake memory responses and a loopback HTTP fixture. They cover ordinary/explicit budgets, envelope stripping, skipped wakes, source attribution/corrections, compaction, workspace isolation, partial indexing, JSON/SSE, authentication failure and timeout behavior. No production model or memory endpoint is called.
