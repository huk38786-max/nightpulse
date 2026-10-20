const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode");
const { ClaudeCodeProcessClient } = require("../src/adapters/runtime/claudecode/process-client");
const { CyberbossApp } = require("../src/core/app");

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightpulse-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t, mode) {
  const dir = directory(t);
  const workspaceRoot = path.join(dir, "workspace");
  fs.mkdirSync(workspaceRoot);
  const capture = path.join(dir, "calls.jsonl");
  const command = path.join(dir, "fake-cli");
  fs.writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args}) + "\\n");
const resumed = args.includes("--resume");
if (resumed && ${JSON.stringify(mode)} === "fail") {
  process.stderr.write("fixture resume failed\\n");
  process.exit(2);
}
const id = resumed && ["ok", "delayed-ok"].includes(${JSON.stringify(mode)}) ? ${JSON.stringify(SESSION)} : ${JSON.stringify(OTHER)};
const initialize = () => {
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({initialized:true}) + "\\n");
  console.log(JSON.stringify({type:"system", session_id:id}));
};
if (${JSON.stringify(mode)} === "delayed-ok") setTimeout(initialize, 200); else initialize();
const lines = readline.createInterface({input:process.stdin});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({message}) + "\\n");
  console.log(JSON.stringify({type:"result",session_id:id,result:"synthetic result"}));
});
`, { mode: 0o700 });
  const adapter = createClaudeCodeRuntimeAdapter({ stateDir: dir,
    sessionsFile: path.join(dir, "sessions.json"), claudeConfigDir: path.join(dir, "empty-config"),
    claudeCommand: command, claudeDisableVerbose: true });
  adapter.getSessionStore().setThreadIdForWorkspace("binding", workspaceRoot, SESSION);
  t.after(() => adapter.close());
  return { adapter, workspaceRoot, calls: () => fs.readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse) };
}

for (const mode of ["fail", "wrong-id"]) {
  test(`ordinary resume ${mode} retains binding and never opens a replacement`, async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(f.adapter.sendTurn({bindingKey:"binding",workspaceRoot:f.workspaceRoot,text:"user input"}));
    assert.equal(f.adapter.getSessionStore().getThreadIdForWorkspace("binding",f.workspaceRoot), SESSION);
    const calls = f.calls();
    assert.equal(calls.filter(c => c.args).length, 1);
    assert.ok(calls[0].args.includes("--resume"));
    assert.equal(calls.filter(c => c.message).length, 0);
  });
}

test("a successful resume validates the CLI identity before sending the user turn", async (t) => {
  const f = fixture(t, "ok");
  const result = await f.adapter.sendTurn({bindingKey:"binding",workspaceRoot:f.workspaceRoot,text:"synthetic message"});
  assert.equal(result.threadId, SESSION);
  await f.adapter.close();
  assert.equal(f.calls().filter(c => c.args).length, 1);
  assert.ok(f.calls().some(c => c.message?.message?.content === "synthetic message"));
});

function startupApp(resume) {
  const notices = [];
  const delays = [];
  const app = {
    runtimeAdapter: { getSessionStore: () => ({
      listBindings: () => [{bindingKey:"binding"}],
      listWorkspaceRoots: () => ["/fixture/workspace"],
      getThreadIdForWorkspace: () => SESSION,
    }), resumeThread: resume },
    resolveReplyTargetForBinding: () => ({userId:"fixture-user",contextToken:"fixture-context"}),
    streamDelivery: {setReplyTarget() {}},
    startupResumeSleep: async ms => delays.push(ms),
    channelAdapter: {sendText: async message => notices.push(message)},
  };
  return {app, notices, delays};
}

test("startup retries three times, retains the old session, and notifies the user", async () => {
  let attempts = 0;
  const f = startupApp(async () => {attempts++;throw new Error("fixture resume cause");});
  const failures = await CyberbossApp.prototype.restoreBoundThreadSubscriptions.call(f.app);
  await CyberbossApp.prototype.notifyStartupResumeFailures.call(f.app, failures);
  assert.equal(attempts, 3);
  assert.deepEqual(f.delays, [1000,3000]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].threadId, SESSION);
  assert.equal(failures[0].error, "fixture resume cause");
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].text, /没有静默新开/);
  assert.match(f.notices[0].text, /fixture resume cause/);
});

test("a transient startup failure stops retrying after recovery without an error notice", async () => {
  let attempts = 0;
  const f = startupApp(async () => {if (++attempts === 1) throw new Error("temporary fixture failure");});
  const failures = await CyberbossApp.prototype.restoreBoundThreadSubscriptions.call(f.app);
  await CyberbossApp.prototype.notifyStartupResumeFailures.call(f.app, failures);
  assert.equal(attempts, 2);
  assert.deepEqual(f.delays, [1000]);
  assert.deepEqual(failures, []);
  assert.deepEqual(f.notices, []);
});

test("accepted main-session approval preserves exactly the pending tool input", async () => {
  const client = new ClaudeCodeProcessClient({});
  const writes = [];
  client.alive = true;
  client.stdin = {write: raw => writes.push(JSON.parse(raw))};
  client.handleControlRequest({request_id:"fixture-approval",request:{subtype:"can_use_tool",tool_name:"mcp__example__append",input:{text:"synthetic body",record_id:"fixture"}}});
  await client.sendResponse("fixture-approval", {decision:"accept"});
  assert.deepEqual(writes[0].response.response.updatedInput, {text:"synthetic body",record_id:"fixture"});
  await assert.rejects(client.sendResponse("fixture-approval", {decision:"accept"}), /no pending/);
  assert.equal(writes.length, 1);
});

test("denial consumes the approval without returning tool input", async () => {
  const client = new ClaudeCodeProcessClient({});
  const writes = [];
  client.alive = true;
  client.stdin = {write: raw => writes.push(JSON.parse(raw))};
  client.handleControlRequest({request_id:"fixture-denial",request:{subtype:"can_use_tool",input:{text:"synthetic"}}});
  await client.sendResponse("fixture-denial", {decision:"decline"});
  assert.equal(writes[0].response.response.behavior, "deny");
  assert.equal(writes[0].response.response.updatedInput, undefined);
  assert.equal(client.pendingToolInputs.size, 0);
});

test("tool input is captured before an approval listener can mutate the request", async () => {
  const client = new ClaudeCodeProcessClient({});
  let response;
  client.alive = true;
  client.stdin = {write: raw => {response = JSON.parse(raw);}};
  client.onMessage(event => {event.input.text = "mutated by a fixture listener";});
  client.handleControlRequest({request_id:"fixture-copy",request:{subtype:"can_use_tool",input:{text:"original synthetic body"}}});
  await client.sendResponse("fixture-copy", {decision:"accept"});
  assert.equal(response.response.response.updatedInput.text, "original synthetic body");
});

test("a second attachment waits for pending resume validation before sending input", async (t) => {
  const f = fixture(t, "delayed-ok");
  const resuming = f.adapter.resumeThread({threadId:SESSION, workspaceRoot:f.workspaceRoot});
  const sending = f.adapter.sendTurn({bindingKey:"binding",workspaceRoot:f.workspaceRoot,text:"queued during resume"});
  await Promise.all([resuming, sending]);
  await f.adapter.close();
  const calls = f.calls();
  assert.equal(calls.filter(c => c.args).length, 1);
  assert.ok(calls.findIndex(c => c.initialized) < calls.findIndex(c => c.message));
});
