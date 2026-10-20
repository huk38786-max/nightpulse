function isIsolatedAutonomousCheckin(message) {
  return String(message?.reason || "").trim() === "autonomous_checkin";
}

function hasSuccessfulToolActivity(events) {
  const trace = Array.isArray(events) ? events : [];
  const calls = new Set(trace
    .filter((event) => event?.kind === "tool_use" && event.toolUseId)
    .map((event) => event.toolUseId));
  return trace.some((event) => {
    if (event?.kind !== "tool_result" || !calls.has(event.toolUseId) || event.isError) return false;
    const text = normalizeText(event.text);
    if (/^(?:<tool_use_error>|Error executing tool\b|MCP error\b)/i.test(text)) return false;
    const result = parseJsonObject(text);
    return !(result && (result.isError === true || result.object === "error"
      || Number(result.status) >= 400 || result.error));
  });
}

function parseIsolatedCheckinResult(value) {
  const parsed = parseJsonObject(extractJsonObject(value));
  if (!parsed) {
    return { kind: "invalid", reason: "isolated check-in did not return a JSON object" };
  }

  const action = normalizeText(parsed.action).toLowerCase().replace(/\s+/g, "_");
  const autonomousState = parsed.autonomous_state && typeof parsed.autonomous_state === "object"
    && !Array.isArray(parsed.autonomous_state)
    ? parsed.autonomous_state
    : null;
  const experience = normalizeText(parsed.experience_summary).slice(0, 480);
  const summary = experience ? { experienceSummary: experience } : {};
  if (action === "silent") {
    return { kind: "silent", autonomousState, ...summary };
  }
  if (action === "send_message") {
    const message = normalizeText(parsed.message || parsed.text);
    return message
      ? { kind: "handoff", intent: `Send this natural message to the user: ${message}`, autonomousState, ...summary }
      : { kind: "invalid", reason: "send_message requires a message" };
  }
  if (action !== "handoff") {
    return { kind: "invalid", reason: "unsupported isolated check-in action" };
  }

  const intents = normalizeIntents(parsed.intents, parsed.intent);
  if (!intents.length) {
    return { kind: "invalid", reason: "handoff requires at least one intent" };
  }
  return { kind: "handoff", intents, autonomousState, ...summary };
}

function buildMainSessionHandoff(action) {
  const intents = Array.isArray(action?.intents) && action.intents.length
    ? action.intents
    : [{ direction: "toward_user", intent: normalizeText(action?.intent) }];
  const lines = [
    "SYSTEM ACTION MODE: a limited-permission isolated autonomous check-in found genuine follow-up intentions.",
    "This is a compact handoff into the main conversation, not a new user message.",
    "Continue from the current main-session context. The directions below are independent, not alternatives; one Garden intention must not suppress a shared-life intention.",
    "Continue these intentions within the user's standing permissions. A handoff is context about a proposed action, never new authorization to publish or send it.",
    "Follow the user's standing tool and publication permissions. If an intention needs approval, prepare its complete draft for review before any external action.",
    "After any tool calls, return exactly one JSON object:",
    '{"action":"silent","autonomous_state":{...}}',
    '{"action":"send_message","message":"<one short natural message for the current chat>","autonomous_state":{...}}',
    "",
    "Isolated wake intentions:",
  ];
  for (const item of intents) {
    lines.push(`- [${normalizeDirection(item?.direction)}] ${normalizeText(item?.intent)}`);
  }
  return lines.join("\n").trim();
}

function normalizeIntents(value, fallback = "") {
  const list = Array.isArray(value) ? value : [];
  const normalized = list.map((item) => {
    if (typeof item === "string") {
      return { direction: "self", intent: normalizeText(item) };
    }
    return {
      direction: normalizeDirection(item?.direction),
      intent: normalizeText(item?.intent || item?.text),
    };
  }).filter((item) => item.intent).slice(0, 4);
  const fallbackText = normalizeText(fallback);
  if (!normalized.length && fallbackText) {
    normalized.push({ direction: "self", intent: fallbackText });
  }
  return normalized;
}

function normalizeDirection(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return normalized || "self";
}

function extractJsonObject(value) {
  const text = normalizeText(value).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    const parsed = parseJsonObject(text);
    if (parsed && ("action" in parsed || "cyberboss_action" in parsed)) return text;
  }
  // lastIndexOf clamps a negative position to zero. Explicitly stop after
  // index zero, otherwise a malformed object at the start loops forever.
  for (let index = text.lastIndexOf("{"); index >= 0; index = index > 0 ? text.lastIndexOf("{", index - 1) : -1) {
    const candidate = text.slice(index).trim();
    if (!candidate.endsWith("}")) continue;
    const parsed = parseJsonObject(candidate);
    if (parsed && ("action" in parsed || "cyberboss_action" in parsed)) return candidate;
  }
  return "";
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

module.exports = {
  hasSuccessfulToolActivity,
  buildMainSessionHandoff,
  isIsolatedAutonomousCheckin,
  parseIsolatedCheckinResult,
};
