// 孵化放行台：存档层。只管 JSON 持久化与操作流水，不解释业务规则。

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const dataDir = join(__dirname, "..", "data");
const dbPath = join(dataDir, "hatchery.json");
const eventPath = join(dataDir, "events.jsonl");
const legacyPath = join(dataDir, "pigeons.json");

export const emptyDb = () => ({
  pigeons: [],
  clutches: [],
  chicks: [],
  meta: { chickSeq: 0, version: 2 }
});

export async function loadDb() {
  if (existsSync(dbPath)) {
    return JSON.parse(await readFile(dbPath, "utf8"));
  }
  await mkdir(dataDir, { recursive: true });
  const db = emptyDb();
  // 旧「赛鸽登记站」数据迁移：保留全部亲鸽档案，孵化域从零开始。
  if (existsSync(legacyPath)) {
    try {
      const legacy = JSON.parse(await readFile(legacyPath, "utf8"));
      if (Array.isArray(legacy.pigeons)) db.pigeons = legacy.pigeons;
    } catch {
      // 旧档损坏则以空库启动，不阻断服务。
    }
  }
  await saveDb(db);
  return db;
}

export async function saveDb(db) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 操作流水：只追加不改写，刷新或重启后可完整回溯。
export async function appendEvent(event) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(eventPath, JSON.stringify(event) + "\n", "utf8");
}

export async function loadEvents() {
  if (!existsSync(eventPath)) return [];
  const raw = await readFile(eventPath, "utf8");
  return raw.split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: "corrupt_line" }; }
  });
}
