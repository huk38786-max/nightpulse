# SPDX-License-Identifier: AGPL-3.0-only
"""Local, source-bound visible-dialogue index. Never uploads or edits transcripts."""
import fcntl
import hashlib
import json
import os
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import conversation_evidence as evidence

READ_LIMIT = 4 * 1024 * 1024
ROW_LIMIT = 512 * 1024
ROOT = None
DB = None
SESSION_ID = ""


def configure(payload):
    global ROOT, DB, SESSION_ID
    workspace = str(Path(payload.get("cwd") or os.getcwd()).resolve())
    scope = hashlib.sha256(workspace.encode()).hexdigest()[:24]
    base = os.environ.get("NIGHTPULSE_RECALL_STATE_DIR")
    if not base:
        base = str(Path(os.environ.get("CYBERBOSS_STATE_DIR", str(Path.home() / ".cyberboss"))) / "recall-hooks")
    ROOT = Path(base).expanduser().resolve() / scope
    DB = ROOT / "evidence.sqlite3"
    SESSION_ID = str(payload.get("session_id") or Path(payload.get("transcript_path") or "session").stem)
    return ROOT


@contextmanager
def locked():
    if ROOT is None:
        raise RuntimeError("Archive must be scoped first")
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(ROOT, 0o700)
    with open(ROOT / ".lock", "a") as lock:
        os.chmod(ROOT / ".lock", 0o600)
        deadline = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Archive busy")
                time.sleep(0.025)
        previous = os.umask(0o077)
        try:
            yield
        finally:
            os.umask(previous)
            for path in ROOT.glob("evidence.sqlite3*"):
                os.chmod(path, 0o600)
            fcntl.flock(lock, fcntl.LOCK_UN)


def sync_all(source):
    """Index only this supplied file, at most READ_LIMIT bytes on each invocation."""
    path = Path(source).expanduser().resolve()
    with locked(), evidence.connect(DB) as con, path.open("rb") as transcript:
        info = os.fstat(transcript.fileno())
        key = "cursor:" + hashlib.sha256(str(path).encode()).hexdigest()
        row = con.execute("select value from meta where key=?", (key,)).fetchone()
        cursor = json.loads(row["value"]) if row else {}
        identity = [info.st_dev, info.st_ino]
        offset = cursor.get("offset", 0)
        # An anchor detects in-place rewrites as well as truncation and rotation.
        anchor_ok = True
        if offset and cursor.get("anchor"):
            transcript.seek(max(0, offset - 256))
            anchor_ok = hashlib.sha256(transcript.read(min(offset, 256))).hexdigest() == cursor["anchor"]
        if cursor.get("identity") != identity or offset > info.st_size or not anchor_ok:
            offset = 0
        partial = bool(cursor.get("partial"))
        if info.st_size - offset > READ_LIMIT:
            offset = info.st_size - READ_LIMIT
            partial = True
        transcript.seek(offset)
        if offset and (not cursor or offset != cursor.get("offset") or not anchor_ok):
            transcript.readline(ROW_LIMIT + 1)  # Drop a partial first row.
            offset = transcript.tell()
        ceiling = min(info.st_size, offset + READ_LIMIT)
        count = 0
        skipping = bool(cursor.get("skipping")) if offset == cursor.get("offset") else False
        while transcript.tell() < ceiling:
            start = transcript.tell()
            raw = transcript.readline(min(ROW_LIMIT + 1, ceiling - start))
            if not raw:
                break
            if skipping:
                offset = transcript.tell()
                skipping = not raw.endswith(b"\n")
                continue
            if not raw.endswith(b"\n"):
                if len(raw) > ROW_LIMIT:
                    partial = True
                    skipping = True
                    offset = transcript.tell()
                    continue
                # A partial append or chunk boundary is retried next invocation.
                break
            offset = transcript.tell()
            try:
                normalized = evidence.normalize(json.loads(raw))
            except (ValueError, TypeError, AttributeError):
                continue
            if normalized is None:
                continue
            con.execute("""insert or ignore into messages
                (session_id,message_id,role,timestamp,text,byte_offset,record_sha256)
                values(?,?,?,?,?,?,?)""", (SESSION_ID, normalized["message_id"], normalized["role"],
                normalized["timestamp"], normalized["text"], start, hashlib.sha256(raw).hexdigest()))
            count += 1
        transcript.seek(max(0, offset - 256))
        anchor = hashlib.sha256(transcript.read(min(offset, 256))).hexdigest()
        con.execute("insert or replace into meta values(?,?)", (key, json.dumps({
            "identity": identity, "offset": offset, "anchor": anchor, "partial": partial, "skipping": skipping})))
        latest = con.execute("select max(timestamp) from messages").fetchone()[0]
        if latest:
            con.execute("insert or replace into meta values('last_dialogue_at',?)", (latest,))
        return {"status": "indexed", "rows_seen": count, "partial": partial, "offset": offset}


def capture(source, trigger="precompact"):
    result = sync_all(source)
    with locked(), evidence.connect(DB) as con:
        rows = con.execute("select message_id from messages where session_id=? order by seq desc limit 16",
                           (SESSION_ID,)).fetchall()[::-1]
        ids = [row["message_id"] for row in rows]
        checkpoint = hashlib.sha256(json.dumps([SESSION_ID, ids]).encode()).hexdigest()
        now = datetime.now(timezone.utc).isoformat()
        con.execute("insert or ignore into checkpoints values(?,?,?,?,?,?)",
                    (checkpoint, SESSION_ID, now, json.dumps(ids), trigger, ""))
    return {**result, "status": "captured", "checkpoint_id": checkpoint}


def save_generated_summary(source, summary):
    result = capture(source, "postcompact")
    if isinstance(summary, str) and summary:
        with locked(), evidence.connect(DB) as con:
            con.execute("update checkpoints set summary=? where checkpoint_id=?",
                        (evidence.redact(summary)[:32000], result["checkpoint_id"]))
    return result
