const { spawn } = require("child_process");
const { buildArgs } = require("./process-client");

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

async function runIsolatedClaudeTurn({
  command = "claude",
  cwd,
  env,
  model = "",
  effort = "",
  extraArgs = [],
  mcpConfigPaths = [],
  resumeSessionId,
  text,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onEvent = null,
  diagnostics = null,
  allowedTools = [],
}) {
  const diagnostic = (method, ...args) => {
    try { diagnostics?.[method]?.(...args); } catch {}
  };
  const args = buildArgs({
    model,
    effort,
    permissionMode: "default",
    disableVerbose: false,
    extraArgs: sanitizeIsolatedExtraArgs(extraArgs),
    mcpConfigPaths,
    resumeSessionId,
    printMode: true,
    forkSession: true,
    noSessionPersistence: true,
  });
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  diagnostic("mark", "process_spawned");
  let stdoutBuffer = "";
  let stderr = "";
  let settled = false;
  let finalResult = "";
  let resultIsError = false;
  let sessionId = "";
  let latestAssistantText = "";
  const events = [];

  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      diagnostic("finish", { outcome: "timeout" });
      reject(new Error("isolated Claude check-in timed out"));
    }, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    timer.unref?.();

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        diagnostic("finish", { outcome: "process_error" });
        reject(error);
        return;
      }
      resolve({
        text: finalResult || latestAssistantText,
        sessionId,
        events,
      });
    };

    const consumeOutput = (chunk = "", flush = false) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      if (flush && stdoutBuffer) {
        lines.push(stdoutBuffer);
        stdoutBuffer = "";
      }
      for (const line of lines) {
        const raw = parseJson(line);
        if (!raw) continue;
        diagnostic("observe", raw);
        if (typeof raw.session_id === "string" && raw.session_id) {
          sessionId = raw.session_id;
        }
        if (raw.type === "assistant" && Array.isArray(raw?.message?.content)) {
          const textBlocks = raw.message.content
            .filter((item) => item?.type === "text" && typeof item.text === "string")
            .map((item) => item.text.trim())
            .filter(Boolean);
          if (textBlocks.length) latestAssistantText = textBlocks.join("\n\n");
          for (const item of raw.message.content) {
            const event = normalizeTraceEvent(item);
            if (!event) continue;
            events.push(event);
            onEvent?.(event);
          }
        }
        if (raw.type === "user" && Array.isArray(raw?.message?.content)) {
          for (const item of raw.message.content) {
            if (item?.type !== "tool_result") continue;
            const event = {
              kind: "tool_result",
              toolUseId: String(item.tool_use_id || ""),
              text: normalizeToolResult(item.content),
              isError: Boolean(item.is_error),
            };
            events.push(event);
            onEvent?.(event);
          }
        }
        if (raw.type === "control_request" && raw?.request?.subtype === "can_use_tool") {
          const decision = isAllowedIsolatedTool(raw.request.tool_name, allowedTools) ? "allow" : "deny";
          const response = decision === "allow"
            ? { behavior: "allow", updatedInput: raw.request.input || {} }
            : { behavior: "deny", message: "This tool is outside the configured wake allowlist. Return a concrete handoff or draft for user review. Do not perform the action through another tool." };
          child.stdin.write(JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: raw.request_id,
              response,
            },
          }) + "\n");
        }
        if (raw.type === "result") {
          finalResult = typeof raw.result === "string" ? raw.result.trim() : "";
          resultIsError = Boolean(raw.is_error) || /^error/.test(String(raw.subtype || ""));
          child.stdin.end();
        }
      }
    };
    child.stdout.on("data", consumeOutput);
    child.stdout.on("end", () => consumeOutput("", true));
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      diagnostic("finish", { outcome: "process_closed", exitCode: code });
      if (resultIsError) {
        finish(new Error("isolated Claude check-in returned an error result"));
        return;
      }
      if (code === 0 && (finalResult || latestAssistantText)) {
        finish();
        return;
      }
      finish(new Error(`isolated Claude check-in exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });

  child.stdin.write(JSON.stringify({
    type: "user",
    message: { role: "user", content: String(text || "") },
  }) + "\n");
  diagnostic("mark", "input_sent");
  return completion;
}

function sanitizeIsolatedExtraArgs(value) {
  const args = Array.isArray(value) ? value : [];
  const safe = [];
  const optionsWithValues = new Set([
    "--permission-mode",
    "--permission-prompt-tool",
    "--allowedTools",
    "--disallowedTools",
    "--tools",
    "--resume",
    "-r",
    "--session-id",
    "--input-format",
    "--output-format",
    "--mcp-config",
  ]);
  const forbiddenFlags = new Set([
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--fork-session",
    "--no-session-persistence",
    "--print",
    "-p",
    "--continue",
    "-c",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = typeof args[index] === "string" ? args[index].trim() : "";
    if (!arg) continue;
    const option = arg.split("=", 1)[0];
    if (forbiddenFlags.has(option)) continue;
    if (optionsWithValues.has(option)) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    safe.push(arg);
  }
  return safe;
}

function normalizeTraceEvent(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "tool_use") {
    return {
      kind: "tool_use",
      toolUseId: String(item.id || ""),
      toolName: String(item.name || ""),
      input: item.input || {},
    };
  }
  return null;
}

// Exact tool names are configured by each deployment. Unknown tools, shell/file
// mutation and deletion are never implicitly authorized by a wake trigger.
function isAllowedIsolatedTool(name, allowedTools = []) {
  const normalized = String(name || "").trim();
  if (normalized === "ToolSearch") return true;
  if (!normalized.startsWith("mcp__")) return false;
  if (/(?:^|__)(?:delete|remove|destroy|purge|erase)(?:_|$)/i.test(normalized)) return false;
  return Array.isArray(allowedTools) && allowedTools.includes(normalized);
}

const isReadOnlyScoutTool = isAllowedIsolatedTool;

function normalizeToolResult(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : JSON.stringify(value);
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item.text === "string") return item.text;
    return JSON.stringify(item);
  }).join("\n");
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    return null;
  }
}

module.exports = {
  isAllowedIsolatedTool,
  isReadOnlyScoutTool,
  runIsolatedClaudeTurn,
  sanitizeIsolatedExtraArgs,
};
