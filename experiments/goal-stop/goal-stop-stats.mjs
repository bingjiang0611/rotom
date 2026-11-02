#!/usr/bin/env node
// 统计本机 rotom/Pi 会话里 /goal 每次"停下来"的原因分布（只读）。
// 用法: node goal-stop-stats.mjs [sessionsDir]   默认 ~/.pi/agent/sessions
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (name.endsWith(".jsonl")) files.push(p);
  }
})(root);

const transitions = new Map(); // "status/stopReason/safetyCause" -> count
const examples = new Map();
let goals = 0;
for (const file of files) {
  let prev = new Map(); // goalId -> status
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"goal-state"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "custom" || e.customType !== "goal-state") continue;
    const g = e.data?.goal; if (!g) continue;
    if (!prev.has(g.id)) goals++;
    const before = prev.get(g.id);
    if (before === "active" && g.status !== "active") {
      const key = `${g.status} / ${g.stopReason ?? "-"} / ${g.safetyPauseCause ?? "-"}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
      if (!examples.has(key)) examples.set(key, `${file} (automaticModelTurns=${g.automaticModelTurns}, iteration=${g.iteration})`);
    }
    prev.set(g.id, g.status);
  }
}
console.log(`扫描 ${files.length} 个会话文件，${goals} 个 goal`);
console.log("active -> 停止 的次数（status / stopReason / safetyPauseCause）:");
for (const [k, v] of [...transitions].sort((a, b) => b[1] - a[1])) {
  console.log(String(v).padStart(5), " ", k, "\n        例:", examples.get(k));
}
