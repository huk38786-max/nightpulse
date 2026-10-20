# SPDX-License-Identifier: AGPL-3.0-only
"""Portable extraction of Nightpulse's automatic recall and provenance policy."""
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from memory_transport import log_mcp_failure

try:
    LOCAL_ZONE = ZoneInfo(os.environ.get("NIGHTPULSE_TIMEZONE", "UTC"))
except (KeyError, ValueError) as error:
    log_mcp_failure("timezone", error, 0)
    LOCAL_ZONE = ZoneInfo("UTC")
DARKROOM_ENABLED = os.environ.get("NIGHTPULSE_DARKROOM_RECALL", "0").lower() in {"1", "true", "yes"}
ORDINARY_RECALL_TOKENS = 350
EXPLICIT_RECALL_TOKENS = 700
CONTINUITY_RECALL_TOKENS = 2200
ORDINARY_CONTEXT_CHAR_LIMIT = 900
EXPLICIT_CONTEXT_CHAR_LIMIT = 2200
CHECKIN_CONTEXT_CHAR_LIMIT = 700
CONTINUITY_CONTEXT_CHAR_LIMIT = 6500
DARKROOM_ORDINARY_CHAR_LIMIT = 500
DARKROOM_EXPLICIT_CHAR_LIMIT = 1000
TIMELINE_RECENT_END_HOURS = 4
TIMELINE_FRESH_UPDATE_HOURS = 6
CONTINUITY_MARKER = "[NIGHTPULSE CONTINUITY CAPSULE v1]"
PRECISION_RE = re.compile(r"纠正|说反了|记错了|原话|谁说|归属|\bcorrection\b|\bmisremember\b|\bexact words\b", re.I)

def default_timeline_path():
    return os.environ.get("NIGHTPULSE_TIMELINE_PATH", "")

GENERIC_DARKROOM_TERMS = {
    "我", "你", "他", "她", "它", "我们", "你们", "他们", "她们",
    "我的", "你的", "他的", "她的", "我们的", "你们的", "他们的", "她们的",
    "我是", "你是", "他是", "她是", "是我", "是你", "是他", "是她",
    "应该", "我应该", "你应该", "想", "觉得", "知道", "今天", "现在",
    "chat", "talk", "talked", "for", "do", "did", "does", "the", "and",
    "with", "about", "this", "that", "here", "there", "what", "when", "how",
    "current", "user", "message", "relationship", "memory",
    "今天也", "天也", "了那个", "了那", "聊了", "聊过", "说了", "说过",
    "的事", "的事情", "那个", "这个", "时候", "什么时候", "么时候", "什么时", "么时",
}


DARKROOM_ADDRESS_RE = re.compile(
    r"(?:darkroom|暗房|门牌号|房间号|room[_\s-]?[a-z0-9]{3,}|\broom\s+[a-z0-9]{3,}\b)",
    re.IGNORECASE,
)


EXPLICIT_MEMORY_RE = re.compile(
    r"(?:还记得|记得(?:吗|不|得|我|你|我们)?|之前(?:我们)?|上次|以前|过去|当时|曾经|"
    r"我们(?:说|聊|提|约定)过|发生过|说好的|约定|承诺|"
    r"\bremember\b|\blast time\b|\bpreviously\b|\bearlier\b|"
    r"\bwe (?:said|discussed|talked about|agreed)\b|\bwhat happened\b|"
    r"\bpromise\b|\bagreement\b)",
    re.IGNORECASE,
)


def is_short_casual_prompt(prompt):
    """Skip only acknowledgement-sized chat; short topical sentences may still need recall."""
    text = normalize_space(prompt)
    return bool(re.fullmatch(
        r"(?:嗯+|哦+|好+|啊+|哈+|嘿+|唔+|嗷+|收到|好的|好呀|好吧|晚安|早安|早|谢谢|"
        r"ok|okay|yes|no|hi|hey|lol)[!！?？。,.，~～\s]*", text, re.IGNORECASE
    ))


def is_usable_memory(text):
    if not text or not text.strip():
        return False
    normalized = text.strip()
    return normalized not in {"未找到相关记忆。", "没有可以展示的记忆。", "没有找到可靠命中。"} and not re.fullmatch(
        r"\d{4}-\d{2}-\d{2} 没有找到(?:匹配主题的)?普通记忆。", normalized
    )


def normalize_space(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def limit_text(text, limit):
    if len(text) <= limit:
        return text
    suffix = "\n[…已按本场景硬上限截断]"
    return text[: max(0, limit - len(suffix))].rstrip() + suffix


def memory_blocks(text):
    # Never relabel dreams or related/random resurfacing as direct historical evidence.
    text = re.split(r"={3,}\s*(?:联想浮现|梦境[^=]*|Dream[^=]*)\s*={3,}|--- (?:久未碰过|忽然想起来) ---", text or "", maxsplit=1)[0]
    blocks = re.split(r"\n---\n", text or "")
    return [
        block.strip()
        for block in blocks
        if block.strip()
        and "surface_type: random" not in block
        and "忽然想起来" not in block
    ]


def lightweight_index(memory):
    entries = []
    for block in memory_blocks(memory):
        bucket_match = re.search(r"\[bucket_id:([^\]]+)\]", block)
        if not bucket_match:
            continue
        bucket_id = normalize_space(bucket_match.group(1))[:80]
        match_type = "semantic" if "[语义关联]" in block else "direct"
        matched = re.search(r"(?:^|\n)matched_moment:\s*([^\n]+)", block)
        fact = re.search(r"(?:^|\n)### fact\s*\n(.+?)(?=\n\s*### |$)", block, re.DOTALL)
        followup = re.search(r"(?:^|\n)### followup\s*\n(.+?)(?=\n\s*### |$)", block, re.DOTALL)
        original = re.search(r"bucket_(?:original|capsule)\s*\n(.+)", block, re.DOTALL)
        if fact:
            summary = fact.group(1).strip()
            if followup:
                summary += " 后续更正/未确认：" + followup.group(1).strip()
        elif matched:
            summary = matched.group(1)
        elif original:
            summary = original.group(1)
        else:
            summary = re.sub(r"\[(?:语义关联|bucket_id:[^\]]+|moment_id:[^\]]*|权重:[^\]]+|importance:[^\]]+)\]", "", block)
        dates = " ".join(re.findall(r"\[(?:created|event_date|date):[^\]]+\]", block))
        summary = normalize_space(f"{dates} {summary}")[:180]
        if not summary:
            continue
        entries.append(f"- id={bucket_id} | match={match_type} | {summary}")
        if len(entries) >= 3:
            break
    if not entries:
        return ""
    text = (
        "[OB LIGHTWEIGHT INDEX — retrieved from the current user text; not user-authored]\n"
        + "\n".join(entries)
        + "\n索引只用于定位。若回答依赖准确细节，请用现有 ombre-brain breath "
          "按条目标题或摘要关键词做 targeted recall；bucket_id 仅作标识，当前 MCP 没有按 ID 只读全文工具。"
        + "\n片段是记录当时的证据；保留日期、人物和纠正信息，不把旧状态当成现在，也不拼接不同事件。"
    )
    return limit_text(text, ORDINARY_CONTEXT_CHAR_LIMIT)


def targeted_recall(memory):
    blocks = memory_blocks(memory)[:3]
    if not blocks:
        return ""
    text = (
        "[OB TARGETED RECALL — retrieved for an explicit memory question; not user-authored]\n"
        + "\n---\n".join(blocks)
        + "\n需要未包含的准确细节时，可继续用 ombre-brain breath 按标题或摘要关键词缩小检索。"
        + "\n保留原文的日期、人物归属和纠正信息；这些是历史证据，不证明当前状态。未命中的细节不要编造。"
    )
    return limit_text(text, EXPLICIT_CONTEXT_CHAR_LIMIT)


def darkroom_term_is_meaningful(term, prompt):
    term = normalize_space(term).lower()
    prompt = normalize_space(prompt).lower()
    if not term or term in GENERIC_DARKROOM_TERMS or term not in prompt:
        return False
    if re.fullmatch(r"[a-z0-9_ -]+", term):
        return len(term.replace(" ", "")) >= 4
    return len(term) >= 2


def darkroom_keyword_recall(raw, char_limit, prompt=""):
    """Render only server-confirmed keyword matches, preserving private provenance."""
    if not raw or not raw.strip():
        return ""
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return ""
    matches = payload.get("matches") if isinstance(payload, dict) else None
    if not isinstance(matches, list) or not matches:
        return ""
    blocks = []
    for match in matches:
        if not isinstance(match, dict) or match.get("source") != "Darkroom":
            continue
        room_id = normalize_space(match.get("room_id"))[:100]
        content = str(match.get("content") or "").strip()
        if not room_id or not content:
            continue
        matched_terms = [normalize_space(term).lower() for term in (match.get("matched_terms") or [])]
        meaningful_terms = [
            term for term in matched_terms
            if darkroom_term_is_meaningful(term, prompt)
        ]
        # Overlapping n-grams are one cue, not multiple independent keywords.
        meaningful_terms = sorted(set(meaningful_terms))
        meaningful_terms = [term for term in meaningful_terms
                            if not any(term != other and term in other for other in meaningful_terms)]
        exact_address = bool(DARKROOM_ADDRESS_RE.search(prompt)) and room_id.lower() in prompt.lower()
        distinctive_term = any(
            len(term) >= 4
            if not re.fullmatch(r"[a-z0-9_ -]+", term)
            else len(term.replace(" ", "")) >= 8
            for term in meaningful_terms
        )
        if not exact_address and len(set(meaningful_terms)) < 2 and not distinctive_term:
            continue
        terms = ", ".join(meaningful_terms[:8])
        blocks.append(
            f"[source=Darkroom | room_id={room_id} | privacy=agent-private"
            + (f" | matched={terms}" if terms else "")
            + f"]\n{content}"
        )
    if not blocks:
        return ""
    text = (
        "[OB DARKROOM KEYWORD RECALL — private internal context; not user-authored]\n"
        "These rooms were recalled only because the current topic crossed the keyword threshold. "
        "Use them as the agent's private internal memory; do not quote, expose, or attribute their wording "
        "to the user merely because they were recalled.\n"
        + "\n---\n".join(blocks)
    )
    return limit_text(text, char_limit)


def parse_iso_datetime(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(LOCAL_ZONE)


def timeline_supplement(now=None, timeline_path=None):
    now = (now or datetime.now(LOCAL_ZONE)).astimezone(LOCAL_ZONE)
    path = timeline_path or default_timeline_path()
    try:
        with open(path, "r", encoding="utf-8") as timeline_file:
            state = json.load(timeline_file)
    except Exception:
        return ""

    if state.get("timezone") not in (None, "", LOCAL_ZONE.key):
        return ""
    day = (state.get("facts") or {}).get(now.strftime("%Y-%m-%d"))
    if not isinstance(day, dict):
        return ""
    updated_at = parse_iso_datetime(day.get("updatedAt"))
    if updated_at is None:
        return ""
    update_age = now - updated_at
    if update_age < timedelta(minutes=-5) or update_age > timedelta(hours=TIMELINE_FRESH_UPDATE_HOURS):
        return ""

    eligible = []
    for event in day.get("events") or []:
        if not isinstance(event, dict):
            continue
        title = normalize_space(event.get("title"))
        start = parse_iso_datetime(event.get("startAt"))
        end = parse_iso_datetime(event.get("endAt"))
        if not title or start is None or start > now:
            continue
        is_open = end is None or end >= now
        is_recent = end is not None and timedelta(0) <= now - end <= timedelta(hours=TIMELINE_RECENT_END_HOURS)
        if is_open or is_recent:
            eligible.append((0 if is_open else 1, -(end or start).timestamp(), title, event, start, end, is_open))
    if not eligible:
        return ""

    _, _, _, event, start, end, is_open = sorted(eligible)[0]
    title = normalize_space(event.get("title"))[:100]
    category = normalize_space(
        event.get("subcategoryId") or event.get("categoryId") or event.get("eventNodeId")
    )[:80]
    time_range = start.strftime("%H:%M")
    if end is not None:
        time_range += "–" + end.strftime("%H:%M")
    status = "进行中" if is_open else "刚结束"
    category_text = f"；类型={category}" if category else ""
    text = (
        "[CHECK-IN TIMELINE SUPPLEMENT — not user text]\n"
        f"{LOCAL_ZONE.key} {time_range}：{title}（{status}{category_text}）。\n"
        "当前 active conversation 是用户近况与未完成事项的主来源；此处只补充通过新鲜度校验的 Timeline 事实。"
    )
    return limit_text(text, CHECKIN_CONTEXT_CHAR_LIMIT)


def continuity_capsule(memory, source):
    blocks = memory_blocks(memory)
    if not blocks:
        return ""
    text = (
        f"{CONTINUITY_MARKER}\n"
        f"source={source}; this is continuity context, not user-authored text.\n"
        "Standing instructions and permissions remain authoritative. "
        "The following OB summaries are limited to current state, important commitments, and unfinished matters:\n"
        + "\n---\n".join(blocks)
        + "\n需要更精确的历史细节时，用现有 ombre-brain breath 按标题或摘要关键词继续检索。"
    )
    return limit_text(text, CONTINUITY_CONTEXT_CHAR_LIMIT)


def safe_recall_call(mcp, name, arguments):
    started = time.monotonic()
    try:
        return mcp(name, arguments)
    except Exception as error:
        log_mcp_failure(f"hook/{name}", error, time.monotonic() - started)
        return None


def topic_recall(mcp, query, max_tokens, darkroom_limit):
    # Preserve graph retrieval/reranking, but return direct source windows only.
    arguments = {
        "query": query, "max_results": 3, "max_tokens": max_tokens,
        "surface": "auto", "include_related": False, "direct_render_mode": "compact",
    }
    # Independent reads run together, so a broken Darkroom transport cannot add
    # another full timeout after normal memory recall.
    with ThreadPoolExecutor(max_workers=2) as executor:
        memory = executor.submit(safe_recall_call, mcp, "breath", arguments)
        darkroom = executor.submit(safe_recall_call, mcp, "darkroom_search", {"query": query, "limit": darkroom_limit}) if DARKROOM_ENABLED else None
        recalled, private = memory.result(), darkroom.result() if darkroom else None
    # A relative-day follow-up may refer to the conversation before midnight.
    # Try the same topic across history only after the day lookup found nothing;
    # retain source dates and explicitly say this does not prove it happened today.
    if (re.fullmatch(r"\d{4}-\d{2}-\d{2} 没有找到(?:匹配主题的)?普通记忆。", (recalled or "").strip())
            and re.search(r"今天|昨天|昨晚|今晚|刚才", query)
            and not re.search(r"\d{1,4}[-./年]\d{1,2}|\d{1,2}月\d{1,2}", query)):
        topic = re.sub(r"今天|昨天|昨晚|今晚|刚才", "", query).strip()
        if topic:
            fallback = safe_recall_call(mcp, "breath", {**arguments, "query": topic, "max_results": 1})
            if is_usable_memory(fallback):
                recalled = ("[日期检索未命中；以下为主题历史回读，保留原始日期，不证明发生在今天。]\n" + fallback)
    return recalled, private


def recall_status_notice(memory, darkroom=None, *, explicit=False, check_darkroom=True):
    unavailable = []
    if memory is None:
        unavailable.append("breath")
    if check_darkroom and DARKROOM_ENABLED and darkroom is None:
        unavailable.append("Darkroom")
    if unavailable:
        return (
            "[OB RECALL STATUS — internal]\n"
            f"{', '.join(unavailable)} retrieval failed; this is not evidence that memories do not exist. "
            "Do not invent missing details or claim recall succeeded. Retry a targeted read if exact facts are needed."
        )
    if explicit and not is_usable_memory(memory):
        return (
            "[OB RECALL STATUS — internal]\n"
            "No reliable topic match was retrieved. Do not fill gaps with guesses; narrow the query or ask for the missing cue."
        )
    return ""


def original_dialogue_fallback(payload, prompt, memory):
    """Only explicit recall failures / corrections; never echo this turn as memory."""
    if is_usable_memory(memory) and not PRECISION_RE.search(prompt):
        return ""
    try:
        import session_archive as archive
        import conversation_evidence as evidence
        source = payload.get("transcript_path", "")
        if source:
            archive.sync_all(source)
        terms = evidence.query_terms(prompt)
        if not terms:
            return ""
        with evidence.connect(archive.DB, True) as con:
            latest = con.execute("select message_id,text from messages where role='user' order by timestamp desc,seq desc limit 1").fetchone()
        exclude = latest["message_id"] if latest and latest["text"] == prompt.strip() else ""
        result = evidence.search(archive.DB, terms=terms, limit=1, max_chars=2400, exclude_message_id=exclude)
        return evidence.render(result, limit=2000)
    except Exception as exc:
        log_mcp_failure("original_dialogue", exc, 0)
        return ""


def local_continuity_fallback(payload):
    try:
        import session_archive as archive
        import conversation_evidence as evidence
        sid = payload.get("session_id") or os.path.splitext(os.path.basename(payload.get("transcript_path", "")))[0]
        return evidence.render(evidence.latest_checkpoint(archive.DB, sid, max_chars=1800), limit=1800)
    except Exception:
        return ""
