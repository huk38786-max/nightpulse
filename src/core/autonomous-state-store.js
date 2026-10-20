const fs = require("fs");
const path = require("path");

const MAX_THREADS = 3;
const MAX_OPEN_LOOPS = 2;
const MAX_TEXT_LENGTH = 240;
const STATE_FIELDS = [
  "threads_in_mind",
  "next_curiosity",
  "unfinished_self_action",
  "relationship_open_loop",
  "shared_life_open_loop",
  "last_self_initiated_at",
];

class AutonomousStateStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.ensureParentDirectory();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  get() {
    try {
      return normalizeAutonomousState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch {
      return emptyAutonomousState();
    }
  }

  update(value, { action = "", hadSuccessfulToolActivity = false } = {}) {
    const current = this.get();
    const patch = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const cleared = new Set(Array.isArray(patch.clear) ? patch.clear.filter((key) => STATE_FIELDS.includes(key)) : []);
    const merged = { ...current };
    for (const key of STATE_FIELDS) {
      if (cleared.has(key)) {
        merged[key] = ["threads_in_mind", "relationship_open_loop", "shared_life_open_loop"].includes(key) ? [] : "";
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const normalized = normalizeAutonomousState({ [key]: patch[key] })[key];
      const hasContent = Array.isArray(normalized) ? normalized.length > 0 : Boolean(normalized);
      if (hasContent) merged[key] = normalized;
    }
    const normalizedMerged = normalizeAutonomousState(merged);
    const normalizedAction = action === "silent" || action === "send_message" ? action : "";
    const trajectoryChanged = hasTrajectoryChanged(current, normalizedMerged);
    const madeProgress = trajectoryChanged || normalizedAction === "send_message" || hadSuccessfulToolActivity === true;
    const stagnantWakeCount = normalizedAction === "silent" && !madeProgress
      ? Math.min(99, normalizeCount(current.stagnantWakeCount) + 1)
      : 0;
    const state = {
      ...normalizedMerged,
      stagnantWakeCount,
      lastWakeAction: normalizedAction || current.lastWakeAction || "",
      lastProgressAt: madeProgress
        ? new Date().toISOString()
        : current.lastProgressAt || "",
      updatedAt: new Date().toISOString(),
    };
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    return state;
  }
}

function emptyAutonomousState() {
  return {
    threads_in_mind: [],
    next_curiosity: "",
    unfinished_self_action: "",
    relationship_open_loop: [],
    shared_life_open_loop: [],
    last_self_initiated_at: "",
    stagnantWakeCount: 0,
    lastWakeAction: "",
    lastProgressAt: "",
    updatedAt: "",
  };
}

function normalizeAutonomousState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    threads_in_mind: normalizeTextList(source.threads_in_mind, MAX_THREADS),
    next_curiosity: normalizeText(source.next_curiosity),
    unfinished_self_action: normalizeText(source.unfinished_self_action),
    relationship_open_loop: normalizeTextList(source.relationship_open_loop, MAX_OPEN_LOOPS),
    shared_life_open_loop: normalizeTextList(source.shared_life_open_loop, MAX_OPEN_LOOPS),
    last_self_initiated_at: normalizeText(source.last_self_initiated_at, 80),
    stagnantWakeCount: normalizeCount(source.stagnantWakeCount),
    lastWakeAction: normalizeText(source.lastWakeAction, 24),
    lastProgressAt: normalizeText(source.lastProgressAt, 80),
    updatedAt: normalizeText(source.updatedAt, 80),
  };
}

function hasTrajectoryChanged(before, after) {
  return STATE_FIELDS.some((key) => JSON.stringify(before?.[key] ?? "") !== JSON.stringify(after?.[key] ?? ""));
}

function normalizeCount(value) {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) && count > 0 ? Math.min(99, count) : 0;
}

function normalizeTextList(value, limit) {
  const list = Array.isArray(value) ? value : (typeof value === "string" && value.trim() ? [value] : []);
  return list.map((item) => normalizeText(item)).filter(Boolean).slice(0, limit);
}

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

module.exports = { AutonomousStateStore, emptyAutonomousState, normalizeAutonomousState };
