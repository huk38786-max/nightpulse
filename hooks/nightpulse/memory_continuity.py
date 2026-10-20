#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Preserve visible quotations before compaction and label derived summaries."""
import json
import os
import sys

import session_archive as archive
from memory_transport import log_mcp_failure


def process(payload):
    if os.environ.get("NIGHTPULSE_ISOLATED_WAKE") == "1":
        return {"status": "isolated_skip"}
    event = payload.get("hook_event_name")
    if event not in {"PreCompact", "PostCompact"}:
        return {"status": "ignored"}
    source = payload.get("transcript_path")
    if not source:
        return {"status": "no_transcript"}
    archive.configure(payload)
    if event == "PostCompact":
        return archive.save_generated_summary(source, payload.get("compact_summary", ""))
    return archive.capture(source, payload.get("trigger") or "precompact")


def main():
    try:
        payload = json.load(sys.stdin)
        if isinstance(payload, dict):
            process(payload)
    except Exception as error:
        log_mcp_failure("continuity", error, 0)
    print("{}")


if __name__ == "__main__":
    main()
