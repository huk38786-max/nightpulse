#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Automatic recall and source continuity for Claude Code command hooks."""
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import recall_policy as policy
import session_archive as archive
from context_policy import is_system_checkin, strip_transport_context
from memory_transport import MCP_TOTAL_TIMEOUT_SECONDS, log_mcp_failure, mcp_call


def continuity_already_in_epoch(source):
    """Only hook attachments count; a user quoting the marker cannot suppress recall."""
    found = False
    if not source:
        return False
    try:
        with open(source, "rb") as transcript:
            size = os.fstat(transcript.fileno()).st_size
            if size > archive.READ_LIMIT:
                transcript.seek(size - archive.READ_LIMIT)
                transcript.readline()
            for raw in transcript:
                try:
                    row = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(row, dict):
                    continue
                if row.get("type") == "system" and row.get("subtype") == "compact_boundary":
                    found = False
                attachment = row.get("attachment")
                if not isinstance(attachment, dict) or attachment.get("type") != "hook_additional_context":
                    continue
                content = attachment.get("content") or []
                if isinstance(content, str):
                    content = [content]
                if any(policy.CONTINUITY_MARKER in item for item in content if isinstance(item, str)):
                    found = True
    except OSError:
        pass
    return found


def hook_response(event, parts, limit):
    text = "\n\n".join(part for part in parts if part)
    if not text:
        return {}
    return {"hookSpecificOutput": {"hookEventName": event,
                                   "additionalContext": policy.limit_text(text, limit)}}


def build_hook_response(payload, *, mcp=None, now=None, timeline_path=None):
    if os.environ.get("NIGHTPULSE_ISOLATED_WAKE") == "1":
        return {}
    archive.configure(payload)
    if mcp is None:
        deadline = time.monotonic() + MCP_TOTAL_TIMEOUT_SECONDS
        def mcp(name, arguments):
            return mcp_call(name, arguments, deadline=deadline)
    event = payload.get("hook_event_name", "UserPromptSubmit")
    source = payload.get("transcript_path", "")
    if event == "SessionStart":
        if payload.get("source") not in {"resume", "compact"} or continuity_already_in_epoch(source):
            return {}
        # Indexing is local and source-bound; no transcript upload or model call.
        if source:
            try:
                archive.capture(source, "resume")
            except Exception as error:
                log_mcp_failure("local_checkpoint", error, 0)
        memory = policy.safe_recall_call(mcp, "breath", {
            "mode": "handoff", "session_id": payload.get("session_id") or Path(source).stem,
            "max_tokens": policy.CONTINUITY_RECALL_TOKENS})
        parts = [policy.recall_status_notice(memory, check_darkroom=False)]
        if policy.is_usable_memory(memory):
            parts.append(policy.continuity_capsule(memory, payload.get("source")))
        local = policy.local_continuity_fallback(payload)
        if local and not policy.is_usable_memory(memory):
            local = policy.CONTINUITY_MARKER + "\n" + local
        parts.append(local)
        return hook_response(event, parts, policy.CONTINUITY_CONTEXT_CHAR_LIMIT)
    if event != "UserPromptSubmit":
        return {}
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}
    if is_system_checkin(prompt):
        return hook_response(event, [policy.timeline_supplement(now, timeline_path)], policy.CHECKIN_CONTEXT_CHAR_LIMIT)
    query = strip_transport_context(prompt)
    if not query or policy.is_short_casual_prompt(query):
        return {}
    explicit = bool(policy.EXPLICIT_MEMORY_RE.search(query))
    precision = bool(policy.PRECISION_RE.search(query))
    memory, private = policy.topic_recall(mcp, query,
        policy.EXPLICIT_RECALL_TOKENS if explicit else policy.ORDINARY_RECALL_TOKENS, 2 if explicit else 1)
    current = (now or datetime.now(policy.LOCAL_ZONE)).astimezone(policy.LOCAL_ZONE)
    parts = [f"[当前时间：{current.isoformat(timespec='minutes')}]",
             policy.recall_status_notice(memory, private, explicit=explicit)]
    if policy.is_usable_memory(memory):
        parts.append(policy.targeted_recall(memory) if explicit else policy.lightweight_index(memory))
    if explicit or precision:
        parts.append(policy.original_dialogue_fallback(payload, query, memory))
    if policy.DARKROOM_ENABLED:
        parts.append(policy.darkroom_keyword_recall(private,
            policy.DARKROOM_EXPLICIT_CHAR_LIMIT if explicit else policy.DARKROOM_ORDINARY_CHAR_LIMIT, query))
    limit = (policy.EXPLICIT_CONTEXT_CHAR_LIMIT if explicit else policy.ORDINARY_CONTEXT_CHAR_LIMIT)
    limit += 2200 if explicit or precision else 0
    limit += (policy.DARKROOM_EXPLICIT_CHAR_LIMIT if explicit else policy.DARKROOM_ORDINARY_CHAR_LIMIT) if policy.DARKROOM_ENABLED else 0
    return hook_response(event, parts, limit + 400)


def main():
    try:
        payload = json.load(sys.stdin)
        result = build_hook_response(payload) if isinstance(payload, dict) else {}
    except Exception as error:
        log_mcp_failure("hook", error, 0)
        result = {}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
