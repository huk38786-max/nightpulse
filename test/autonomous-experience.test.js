const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AutonomousExperienceStore } = require("../src/core/autonomous-experience-store");
const { CyberbossApp } = require("../src/core/app");
const { parseIsolatedCheckinResult } = require("../src/core/isolated-checkin");
const { ClaudeCodeProcessClient } = require("../src/adapters/runtime/claudecode/process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("../src/adapters/runtime/claudecode/events");

const scope = { bindingKey: "weixin:test-user", workspaceRoot: "/workspace", sessionId: "original-main" };
const post = { id: 101, title: "关于上一个帖子", body: "正文内容", reply_total: 1,
  reply_range: { start: 1, end: 30, returned: 1 }, replies: [{ id: 42, floor: 1, body: "唯一一条回复" }], view_count: 10 };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-experience-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "experiences.json");
  return { filePath, store: new AutonomousExperienceStore({ filePath }) };
}
function events(value = post, suffix = "1") {
  return [
    { kind: "tool_use", toolUseId: `read-${suffix}`, toolName: "mcp__galatea-garden__get_thread", input: { thread_id: 101, reply_end_floor: 30 } },
    { kind: "tool_result", toolUseId: `read-${suffix}`, text: JSON.stringify([{ type: "text", text: JSON.stringify(value) }]) },
  ];
}
function record(store, values = events(), runId = "wake-1", extra = {}) {
  const observer = store.beginObservation({ ...scope, runId, ...extra });
  values.forEach((event) => observer.observe(event));
  return observer;
}

test("successful fork reads survive restart and use returned floors, not requested range", (t) => {
  const { store, filePath } = fixture(t);
  record(store);
  const restarted = new AutonomousExperienceStore({ filePath });
  const receipt = restarted.prepare({ ...scope, isolated: true });
  assert.match(receipt.text, /101/);
  assert.match(receipt.text, /正文内容/);
  assert.match(receipt.text, /"returnedFloors":"1"/);
  assert.doesNotMatch(receipt.text, /"returnedFloors":"1-30"/);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("four identical reads with changing view counts produce one fact and a shared read index", (t) => {
  const { store } = fixture(t);
  for (let i = 0; i < 4; i++) record(store, events({ ...post, view_count: 10 + i }, `${i}`), `wake-${i}`);
  const receipt = store.prepare({ ...scope, isolated: true });
  assert.equal(receipt.throughSequence, 1);
  assert.equal(receipt.text.match(/"kind":"tool_fact"/g).length, 1);
  assert.match(receipt.text, /do not fetch the same full post again/);
});

test("incremental reads preserve earlier floors and body-read status", (t) => {
  const { store } = fixture(t);
  record(store);
  record(store, events({ ...post, body: undefined, reply_total: 3,
    replies: [{ floor: 2, body: "新回复" }, { floor: 3, body: "又一条" }] }, "2"), "wake-2");
  const receipt = store.prepare({ ...scope, isolated: true });
  assert.match(receipt.text, /"returnedFloors":"1-3"/);
  assert.match(receipt.text, /"bodyRead":true/);
  assert.match(receipt.text, /新回复/);
});

test("tool errors, unpaired results, discovery and raw reasoning never become experiences", (t) => {
  const { store } = fixture(t);
  const observer = store.beginObservation({ ...scope, runId: "bad-wake" });
  observer.observe({ kind: "thinking", text: "private chain of thought" });
  observer.observe({ ...events()[1], toolUseId: "unpaired" });
  for (const [i, text] of [JSON.stringify({ isError: true }), JSON.stringify({ error: "failure" }),
    JSON.stringify({ success: false }), JSON.stringify({ content: [{ type: "text", text: '{"status":500}' }] }),
    JSON.stringify([{ type: "text", text: "Error executing tool" }])].entries()) {
    observer.observe({ kind: "tool_use", toolUseId: `${i}`, toolName: "mcp__garden__create_reply", input: { body: "not sent" } });
    observer.observe({ kind: "tool_result", toolUseId: `${i}`, text });
  }
  observer.observe({ kind: "tool_use", toolUseId: "search", toolName: "ToolSearch" });
  observer.observe({ kind: "tool_result", toolUseId: "search", text: "found tools" });
  assert.equal(store.prepare(scope), null);
});

test("structured success receipts retain actions and excerpts without raw secrets or URLs", (t) => {
  const { store, filePath } = fixture(t);
  record(store, [
    { kind: "tool_use", toolUseId: "push", toolName: "mcp__push__send", input: { message: "吃饭了", token: "secret-token" } },
    { kind: "tool_result", toolUseId: "push", text: '{"success":true,"privateUrl":"https://example.com/?token=secret"}' },
  ]);
  assert.match(store.prepare(scope).text, /已成功调用 send/);
  assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /secret-token|privateUrl|https:/);
});

test("self summaries are labelled separately and are bounded", (t) => {
  const { store } = fixture(t);
  const result = parseIsolatedCheckinResult(JSON.stringify({ action: "silent", experience_summary: "我的感受".repeat(300) }));
  assert.equal(result.experienceSummary.length, 480);
  record(store, []).finish({ summary: result.experienceSummary });
  assert.match(store.prepare(scope).text, /"kind":"self_summary"/);
  assert.doesNotMatch(store.prepare(scope).text, /"kind":"tool_fact"/);
});

test("fork delivery never advances the main cursor; failed main turns retry the same receipts", (t) => {
  const { store } = fixture(t);
  record(store);
  const before = store.prepare(scope);
  store.prepare({ ...scope, isolated: true });
  assert.equal(store.prepare(scope).throughSequence, before.throughSequence);
  store.trackDelivery({ threadId: scope.sessionId, turnId: "failed" }, before);
  store.settleDelivery({ threadId: scope.sessionId, turnId: "failed", succeeded: false });
  assert.deepEqual(store.prepare(scope), before);
  store.trackDelivery({ threadId: scope.sessionId, turnId: "done" }, before);
  store.settleDelivery({ threadId: scope.sessionId, turnId: "done", succeeded: true });
  assert.equal(store.prepare(scope), null);
  assert.match(store.prepare({ ...scope, isolated: true }).text, /GARDEN READ INDEX/);
  assert.ok(store.prepare({ ...scope, sessionId: "different-main" }));
});

test("acknowledging a packet does not consume later activity, and scopes do not leak", (t) => {
  const { store } = fixture(t);
  record(store);
  const receipt = store.prepare(scope);
  record(store, events({ ...post, body: "正文改动" }, "2"), "wake-2");
  store.trackDelivery({ threadId: scope.sessionId, turnId: "done" }, receipt);
  store.settleDelivery({ threadId: scope.sessionId, turnId: "done", succeeded: true });
  assert.equal(store.prepare(scope).throughSequence, 2);
  assert.match(store.prepare(scope).text, /正文改动/);
  assert.equal(store.prepare({ ...scope, bindingKey: "other-user" }), null);
  assert.equal(store.prepare({ ...scope, workspaceRoot: "/different" }), null);
});

test("a very fast completion before send returns still acknowledges the correct packet", (t) => {
  const { store } = fixture(t);
  record(store);
  const receipt = store.prepare(scope);
  store.settleDelivery({ threadId: scope.sessionId, turnId: "fast", succeeded: true });
  store.trackDelivery({ threadId: scope.sessionId, turnId: "fast" }, receipt);
  assert.equal(store.prepare(scope), null);
});

test("CLI error results retain their error flag through the completion event and cannot acknowledge receipts", async (t) => {
  const { store } = fixture(t);
  record(store);
  const receipt = store.prepare(scope);
  let mapped;
  const client = {
    pendingTurnId: "limited", activeThreadId: scope.sessionId, sessionId: scope.sessionId,
    activeToolUseIds: new Set(), pendingApprovalIds: new Set(), notifyActivityChanged() {},
    emit: (message) => { mapped = mapClaudeCodeMessageToRuntimeEvent(message); },
  };
  ClaudeCodeProcessClient.prototype.handleResult.call(client, { type: "result", is_error: true, result: "session limit reached" });
  assert.equal(mapped.type, "runtime.turn.completed");
  assert.equal(mapped.payload.isError, true);
  store.trackDelivery({ threadId: scope.sessionId, turnId: "limited" }, receipt);
  await assert.rejects(CyberbossApp.prototype.handleRuntimeEvent.call({
    autonomousExperienceStore: store,
    streamDelivery: { handleRuntimeEvent: async () => { throw new Error("stop after hook"); } },
  }, mapped), /stop after hook/);
  assert.deepEqual(store.prepare(scope), receipt);
});

test("large backlogs are delivered in bounded packets without skipping undelivered entries", (t) => {
  const { store } = fixture(t);
  for (let i = 0; i < 30; i++) record(store, [], `wake-${i}`).finish({ summary: `${i}: ${"记录".repeat(230)}` });
  let last = 0;
  while (true) {
    const receipt = store.prepare(scope);
    if (!receipt) break;
    assert.ok(receipt.text.length < 3500);
    assert.ok(receipt.throughSequence > last);
    last = receipt.throughSequence;
    store.trackDelivery({ threadId: scope.sessionId, turnId: `${last}` }, receipt);
    store.settleDelivery({ threadId: scope.sessionId, turnId: `${last}`, succeeded: true });
  }
  assert.equal(last, 30);
});

test("corrupt ledgers fail visibly without overwriting saved data", (t) => {
  const { store, filePath } = fixture(t);
  fs.writeFileSync(filePath, "damaged");
  assert.throws(() => record(store));
  assert.equal(fs.readFileSync(filePath, "utf8"), "damaged");
});


function mainApp(store, sendTurn) {
  return {
    config: {}, autonomousExperienceStore: store,
    turnGateStore: { begin: () => "scope", attachThread() {}, releaseScope() {} },
    channelAdapter: { async sendTyping() {}, async sendText() {} },
    runtimeAdapter: {
      getSessionStore: () => ({ getRuntimeParamsForWorkspace: () => ({}), getThreadIdForWorkspace: () => scope.sessionId }),
      sendTurn,
    },
    buildRuntimeTurn: async ({ prepared }) => ({ text: `NORMAL USER CHAT MODE\n${prepared.originalText}` }),
    streamDelivery: { bindReplyTargetForTurn() {} },
  };
}

test("normal chat receives fork facts appended to unchanged inbound text; send failure keeps them pending", async (t) => {
  const { store } = fixture(t);
  record(store);
  let sent;
  const app = mainApp(store, async (payload) => { sent = payload; return { threadId: scope.sessionId, turnId: "chat" }; });
  const prepared = { provider: "weixin", originalText: "你刚刚看了那条帖子", senderId: "user" };
  assert.equal(await CyberbossApp.prototype.dispatchPreparedTurn.call(app, { ...scope, prepared }), true);
  assert.ok(sent.text.startsWith(`NORMAL USER CHAT MODE\n${prepared.originalText}\n\n`));
  assert.match(sent.text, /101/);
  assert.ok(store.prepare(scope), "accepting a send alone does not acknowledge");
  // Exercise the application's actual completion hook without invoking chat delivery.
  app.streamDelivery.handleRuntimeEvent = async () => { throw new Error("stop after acknowledgement hook"); };
  await assert.rejects(CyberbossApp.prototype.handleRuntimeEvent.call(app, {
    type: "runtime.turn.completed", payload: { threadId: scope.sessionId, turnId: "chat" },
  }), /stop after acknowledgement/);
  assert.equal(store.prepare(scope), null);

  record(store, events({ ...post, body: "新内容" }, "new"), "wake-new");
  app.runtimeAdapter.sendTurn = async () => { throw new Error("offline"); };
  assert.equal(await CyberbossApp.prototype.dispatchPreparedTurn.call(app, { ...scope, prepared }), false);
  assert.match(store.prepare(scope).text, /新内容/);
});

test("silent or invalid fork results still save completed work; later timeout does too", async (t) => {
  for (const outcome of ["silent", "invalid", "timeout"]) {
    const { store } = fixture(t);
    let sent;
    const app = {
      config: {}, autonomousExperienceStore: store,
      turnGateStore: { begin: () => "scope", releaseScope() {} },
      runtimeAdapter: {
        getSessionStore: () => ({ getRuntimeParamsForWorkspace: () => ({}), getThreadIdForWorkspace: () => scope.sessionId }),
        sendIsolatedTurn: async (payload) => {
          sent = payload;
          events().forEach(payload.onEvent);
          if (outcome === "timeout") throw new Error("timed out");
          return { text: outcome === "silent" ? '{"action":"silent","experience_summary":"看过帖子后想再想想"}' : "not JSON", events: events() };
        },
      },
      buildRuntimeTurn: async () => ({ text: "SYSTEM ACTION MODE" }),
      publishIsolatedCheckinTrace: async () => {},
      autonomousStateStore: { update() {} },
    };
    await CyberbossApp.prototype.dispatchIsolatedAutonomousCheckin.call(app, { ...scope, message: {}, prepared: {} });
    assert.equal(sent.text, "SYSTEM ACTION MODE");
    const receipt = store.prepare(scope);
    assert.match(receipt.text, /101/);
    assert.equal(receipt.text.match(/"kind":"tool_fact"/g).length, 1, "callback and final trace are deduplicated");
    if (outcome === "silent") assert.match(receipt.text, /看过帖子后想再想想/);
  }
});

test("new fork receives the read index while the parent still has pending experiences", async (t) => {
  const { store } = fixture(t);
  record(store);
  let sent;
  const app = {
    config: {}, autonomousExperienceStore: store,
    turnGateStore: { begin: () => "scope", releaseScope() {} },
    runtimeAdapter: {
      getSessionStore: () => ({ getRuntimeParamsForWorkspace: () => ({}), getThreadIdForWorkspace: () => scope.sessionId }),
      sendIsolatedTurn: async (payload) => { sent = payload; return { text: '{"action":"silent"}', events: [] }; },
    },
    buildRuntimeTurn: async () => ({ text: "SYSTEM ACTION MODE" }),
    publishIsolatedCheckinTrace: async () => {}, autonomousStateStore: { update() {} },
  };
  await CyberbossApp.prototype.dispatchIsolatedAutonomousCheckin.call(app, { ...scope, message: {}, prepared: {} });
  assert.ok(sent.text.startsWith("SYSTEM ACTION MODE\n\n"));
  assert.match(sent.text, /"threadId":"101"/);
  assert.ok(store.prepare(scope));
});
