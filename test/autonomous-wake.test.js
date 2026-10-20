const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutonomousStateStore } = require("../src/core/autonomous-state-store");
const { AutonomousExperienceStore } = require("../src/core/autonomous-experience-store");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");
const { CyberbossApp } = require("../src/core/app");
const { buildArgs } = require("../src/adapters/runtime/claudecode/process-client");
const { isAllowedIsolatedTool, sanitizeIsolatedExtraArgs, runIsolatedClaudeTurn } = require("../src/adapters/runtime/claudecode/isolated-runner");

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-wake-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("continuity survives restart, preserves empty updates, and clears only named fields", (t) => {
  const filePath = path.join(directory(t), "state.json");
  const first = new AutonomousStateStore({ filePath });
  first.update({ threads_in_mind: ["synthetic discussion"], next_curiosity: "read a new reply" });
  const restarted = new AutonomousStateStore({ filePath });
  restarted.update({ threads_in_mind: [], next_curiosity: "" }, { action: "silent" });
  assert.deepEqual(restarted.get().threads_in_mind, ["synthetic discussion"]);
  assert.equal(restarted.get().stagnantWakeCount, 1);
  restarted.update({}, { action: "silent", hadSuccessfulToolActivity: true });
  assert.equal(restarted.get().stagnantWakeCount, 0);
  restarted.update({ clear: ["threads_in_mind"] });
  assert.deepEqual(restarted.get().threads_in_mind, []);
  assert.equal(restarted.get().next_curiosity, "read a new reply");
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("queued wake metadata survives disk reload and duplicate wakes coalesce", (t) => {
  const filePath = path.join(directory(t), "queue.json");
  const queue = new SystemMessageQueueStore({ filePath });
  const message = { id: "wake-1", accountId: "test", senderId: "test-user", workspaceRoot: "/workspace", text: "scheduled wake", reason: "autonomous_checkin", coalesceKey: "autonomous_checkin" };
  queue.enqueue(message);
  queue.enqueue({ ...message, id: "wake-2" });
  const reloaded = new SystemMessageQueueStore({ filePath });
  const messages = reloaded.drainForAccount("test");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "wake-2");
  assert.equal(messages[0].reason, "autonomous_checkin");
});

test("generic wake framing preserves deployment permissions and prebuilt handoffs", () => {
  const dispatcher = new SystemMessageDispatcher({ queueStore: {}, accountId: "test", config: { isolatedCheckinEnabled: true }, autonomousStateStore: { get: () => ({ next_curiosity: "synthetic interest" }) } });
  const message = { id: "wake", senderId: "test-user", workspaceRoot: "/workspace", text: "scheduled wake", reason: "autonomous_checkin" };
  const prepared = dispatcher.buildPreparedMessage(message);
  assert.match(prepared.text, /synthetic interest/);
  assert.match(prepared.text, /standing permissions/);
  assert.match(prepared.text, /full draft for review/);
  assert.equal(prepared.reason, "autonomous_checkin");
  assert.equal(dispatcher.buildPreparedMessage({ ...message, reason: "isolated_handoff", text: "review this draft" }).text, "review this draft");
});

test("fork identity is fixed and inherited permission/session overrides are stripped", () => {
  const resumeSessionId = "11111111-1111-4111-8111-111111111111";
  const args = buildArgs({ resumeSessionId, printMode: true, forkSession: true, noSessionPersistence: true, extraArgs: [] });
  assert.ok(args.includes("--print"));
  assert.ok(args.includes("--fork-session"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args[args.indexOf("--resume") + 1], resumeSessionId);
  assert.deepEqual(sanitizeIsolatedExtraArgs(["--resume", "wrong-session", "--permission-mode=bypassPermissions", "--dangerously-skip-permissions", "--continue", "--model", "test-model"]), ["--model", "test-model"]);
  assert.equal(isAllowedIsolatedTool("ToolSearch"), true);
  for (const name of ["Bash", "Write", "Edit", "mcp__example__send", "mcp__future__read"]) assert.equal(isAllowedIsolatedTool(name), false);
  assert.equal(isAllowedIsolatedTool("mcp__example__read", ["mcp__example__read"]), true);
  assert.equal(isAllowedIsolatedTool("mcp__example__send", ["mcp__example__send"]), true);
  assert.equal(isAllowedIsolatedTool("mcp__example__delete_item", ["mcp__example__delete_item"]), false);
});

test("confirmation-required tool responses are not recorded as completed publications", (t) => {
  const store = new AutonomousExperienceStore({ filePath: path.join(directory(t), "receipts.json") });
  const scope = { bindingKey: "test", workspaceRoot: "/workspace", sessionId: "main" };
  const observer = store.beginObservation({ ...scope, runId: "wake" });
  for (const status of ["write_confirmation_required", "approval_required"]) {
    observer.observe({ kind: "tool_use", toolUseId: status, toolName: "mcp__example__create_reply", input: { body: "synthetic draft" } });
    observer.observe({ kind: "tool_result", toolUseId: status, text: JSON.stringify({ status }) });
  }
  assert.equal(store.prepare(scope), null);
});

test("background dispatch keeps polling available and never launches overlapping flushes", async () => {
  let finish;
  let dispatched = 0;
  const done = new Promise((resolve) => { finish = resolve; });
  const app = { config: { isolatedCheckinEnabled: true }, systemMessageFlushPromise: null,
    systemMessageDispatcher: { drainPending: () => [{ id: "wake" }], requeue() { assert.fail("unexpected requeue"); } },
    dispatchSystemMessage: async () => { dispatched++; await done; return true; },
  };
  assert.equal(await CyberbossApp.prototype.flushPendingSystemMessages.call(app), true);
  assert.equal(await CyberbossApp.prototype.flushPendingSystemMessages.call(app), false);
  assert.equal(dispatched, 1);
  const pending = app.systemMessageFlushPromise;
  finish();
  await pending;
  assert.equal(app.systemMessageFlushPromise, null);
});

test("fake CLI receives allowed arguments unchanged and never runs a real model", async (t) => {
  const dir = directory(t);
  const command = path.join(dir, "fake-cli");
  fs.writeFileSync(command, `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    console.log(JSON.stringify({ type: "control_request", request_id: "permission", request: { subtype: "can_use_tool", tool_name: "mcp__example__read", input: { item_id: "fixture" } } }));
  } else if (msg.type === "control_response") {
    console.log(JSON.stringify({ type: "result", result: JSON.stringify({ action: "silent", permission: msg.response.response, argv: process.argv.slice(2) }) }));
    lines.close();
  }
});
`, { mode: 0o700 });
  const result = await runIsolatedClaudeTurn({ command, cwd: dir, env: process.env,
    resumeSessionId: "11111111-1111-4111-8111-111111111111", text: "synthetic wake", timeoutMs: 2000,
    allowedTools: ["mcp__example__read"],
  });
  const output = JSON.parse(result.text);
  assert.equal(output.permission.behavior, "allow");
  assert.deepEqual(output.permission.updatedInput, { item_id: "fixture" });
  assert.ok(output.argv.includes("--no-session-persistence"));
});

test("CLI error envelopes cannot be accepted as a successful isolated action", async (t) => {
  const dir = directory(t);
  const command = path.join(dir, "fake-error-cli");
  fs.writeFileSync(command, `#!${process.execPath}
console.log(JSON.stringify({ type: "result", is_error: true, result: '{"action":"silent"}' }));
process.exit(0);
`, { mode: 0o700 });
  await assert.rejects(runIsolatedClaudeTurn({ command, cwd: dir, env: process.env,
    text: "synthetic wake", timeoutMs: 2000,
  }), /error result/);
});
