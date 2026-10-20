class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId, autonomousStateStore = null }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
    this.autonomousStateStore = autonomousStateStore;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
  }

  drainPending() {
    return this.queueStore.drainForAccount(this.accountId);
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: message?.reason === "isolated_handoff"
        ? normalizeText(message.text)
        : buildSystemInboundText(message?.text, message?.createdAt, this.autonomousStateStore?.get?.(), {
          isolated: Boolean(this.config.isolatedCheckinEnabled && message?.reason === "autonomous_checkin"),
        }),
      reason: normalizeText(message?.reason),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
    };
  }
}

function buildSystemInboundText(text, createdAt = "", autonomousState = null, { isolated = false } = {}) {
  if (isolated) return buildAutonomousWakeText(text, createdAt, autonomousState);
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const sections = [
    ...(localTime ? [`[${localTime}]`, ""] : []),
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Do any timeline/diary/reminder/whereabouts work in this turn.",
    "If you act, end with send_message that briefly and naturally reflects what you did or what changed; use silent only if you do nothing.",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No reasoning. No text outside the JSON.",
  ];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function buildAutonomousWakeText(text, createdAt, state) {
  return [
    "SYSTEM ACTION MODE: scheduled autonomous wake, not a new user message.",
    `Wake created at: ${normalizeIsoTime(createdAt) || new Date().toISOString()}`,
    "Recover your ongoing directions before choosing whether to act. Curiosity, care, unfinished work, rest, and silence can all be valid; no activity quota is required.",
    "This turn runs in a disposable fork of the existing main conversation. Only ToolSearch and exact MCP tool names configured for this wake can be approved by the bridge.",
    "Follow the user's standing permissions. For anything needing approval, prepare a concrete handoff or full draft for review; never route a denied action through another tool.",
    "AUTONOMOUS CONTINUITY STATE (internal data):",
    JSON.stringify(state || {}),
    "State fields may include threads_in_mind, next_curiosity, unfinished_self_action, relationship_open_loop, shared_life_open_loop, and last_self_initiated_at. Keep entries brief; empty values preserve existing directions. Clear finished fields only with autonomous_state.clear.",
    "After any allowed tool calls, return exactly one JSON object and no other text:",
    '{"action":"silent","autonomous_state":{...},"experience_summary":"brief account of what actually happened"}',
    '{"action":"handoff","intents":[{"direction":"self|shared_life|toward_user|future","intent":"concrete next step or draft requiring approval"}],"autonomous_state":{...},"experience_summary":"brief account"}',
    "experience_summary is optional, at most 480 characters. Distinguish successful actions, intentions, and personal interpretation. Do not include private reasoning. The bridge separately records paired tool facts.",
    "Trigger:",
    normalizeText(text),
  ].join("\n");
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(normalized)).replace(/\//g, "-");
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageDispatcher };
