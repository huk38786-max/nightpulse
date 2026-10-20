const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const { parseIsolatedCheckinResult } = require("../src/core/isolated-checkin");

test("invalid isolated results finish without blocking the bridge event loop", () => {
  const inputs = [
    "{}",
    '{"action":broken}',
    '{"action":"silent"',
    '{"autonomous_state":{"threads_in_mind":["unfinished"]}}',
    "```json\n{}\n```",
    "",
    "No JSON returned",
  ];
  // A test timeout cannot interrupt a synchronous infinite loop. Isolate this
  // regression in a child so the test runner can terminate it safely.
  const script = `
    const { parseIsolatedCheckinResult } = require(${JSON.stringify(require.resolve("../src/core/isolated-checkin"))});
    console.log(JSON.stringify(${JSON.stringify(inputs)}.map(parseIsolatedCheckinResult)));
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 2000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  assert.equal(results.length, inputs.length);
  for (const result of results) assert.equal(result.kind, "invalid");
});

test("isolated result extraction preserves valid nested, fenced, and prefixed actions", () => {
  const action = {
    action: "silent",
    autonomous_state: { threads_in_mind: ["continue reading"] },
    experience_summary: "Read the discussion; no reply sent.",
  };
  const json = JSON.stringify(action);
  for (const input of [json, "```json\n" + json + "\n```", "Finished reading.\n" + json]) {
    const result = parseIsolatedCheckinResult(input);
    assert.equal(result.kind, "silent");
    assert.deepEqual(result.autonomousState, action.autonomous_state);
    assert.equal(result.experienceSummary, action.experience_summary);
  }
});
