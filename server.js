import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDb, saveDb, appendEvent, loadEvents } from "./src/store.js";
import * as rules from "./src/rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = join(__dirname, "public", "index.html");
const port = Number(process.env.PORT || 3024);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new rules.RuleError("invalid_json");
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

const STATUS_BY_CODE = {
  ring_exists: 409, pigeon_not_found: 404, egg_not_found: 404, chick_not_found: 404,
  batch_rejected: 400, ring_no_required: 400, invalid_json: 400
};

async function record(type, summary, payload) {
  await appendEvent({ at: new Date().toISOString(), type, summary, ...payload });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(pagePath, "utf8"));
    }

    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, rules.stateView(db));
    if (req.method === "GET" && url.pathname === "/api/events") return sendJson(res, 200, await loadEvents());

    // 档案
    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      const pigeon = rules.createPigeon(db, input);
      await saveDb(db);
      await record("pigeon_created", `新建亲鸽 ${pigeon.ringNo}`);
      return sendJson(res, 201, pigeon);
    }

    const correctionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/corrections$/);
    if (correctionMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(correctionMatch[1]);
      const patch = await body(req);
      const result = rules.correctPigeon(db, ringNo, patch);
      await saveDb(db);
      await record("pigeon_corrected",
        `${ringNo} 更正[${result.changed.join(",") || "无变更"}] → 蛋${result.invalidatedEggs.length} 雏${result.invalidatedChicks.length} 失效`,
        { ringNo, changed: result.changed, invalidatedEggs: result.invalidatedEggs, invalidatedChicks: result.invalidatedChicks });
      return sendJson(res, 200, result);
    }

    const vaccineMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/vaccines$/);
    if (vaccineMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(vaccineMatch[1]);
      const input = await body(req);
      const result = rules.addVaccine(db, ringNo, input);
      await saveDb(db);
      await record("vaccine_added",
        `${ringNo} 疫苗「${input.name || ""}」→ 蛋${result.invalidatedEggs.length} 雏${result.invalidatedChicks.length} 失效`,
        { ringNo, invalidatedEggs: result.invalidatedEggs, invalidatedChicks: result.invalidatedChicks });
      return sendJson(res, 200, result);
    }

    // 整批入孵
    if (req.method === "POST" && url.pathname === "/api/incubations") {
      const input = await body(req);
      const result = rules.createIncubationBatch(db, input.rows || []);
      await saveDb(db);
      await record("incubation_batch", `窝次 ${result.clutches.join("、")}，${result.eggs.length} 枚蛋整批入孵`,
        { clutches: result.clutches, eggIds: result.eggs.map(e => e.eggId) });
      return sendJson(res, 201, result);
    }

    // 照蛋
    const candleMatch = url.pathname.match(/^\/api\/eggs\/(.+)\/candles$/);
    if (candleMatch && req.method === "POST") {
      const eggId = decodeURIComponent(candleMatch[1]);
      const input = await body(req);
      const egg = rules.addCandle(db, eggId, input);
      await saveDb(db);
      await record("candle_recorded", `${eggId} 第${input.day}日照蛋：${input.result} → ${egg.status}`, { eggId, status: egg.status });
      return sendJson(res, 200, egg);
    }

    // 出壳
    const hatchMatch = url.pathname.match(/^\/api\/eggs\/(.+)\/hatch$/);
    if (hatchMatch && req.method === "POST") {
      const eggId = decodeURIComponent(hatchMatch[1]);
      const input = await body(req);
      const chick = rules.hatchEgg(db, eggId, input);
      await saveDb(db);
      await record("egg_hatched", `${eggId} 出壳 → 幼鸽 ${chick.chickId}（占出壳名额）`, { eggId, chickId: chick.chickId });
      return sendJson(res, 201, chick);
    }

    // 复核
    const reviewMatch = url.pathname.match(/^\/api\/chicks\/(.+)\/reviews$/);
    if (reviewMatch && req.method === "POST") {
      const chickId = decodeURIComponent(reviewMatch[1]);
      const input = await body(req);
      const result = rules.submitReview(db, chickId, input);
      await saveDb(db);
      if (!result.replayed) {
        await record("review_submitted", `${chickId} 申请${input.applyNo} ${input.reviewer} 判「${input.result}」→ ${result.chick.status}`,
          { chickId, applyNo: input.applyNo });
      } else {
        await record("review_replayed", `${chickId} 申请${input.applyNo} 重复提交，沿用首次结果`, { chickId, applyNo: input.applyNo });
      }
      return sendJson(res, 200, result);
    }

    // 登记足环入场
    const ringMatch = url.pathname.match(/^\/api\/chicks\/(.+)\/ring$/);
    if (ringMatch && req.method === "POST") {
      const chickId = decodeURIComponent(ringMatch[1]);
      const input = await body(req);
      const result = rules.registerRing(db, chickId, input);
      await saveDb(db);
      await record("ring_registered", `${chickId} 登记足环 ${input.ringNo} 入场`, { chickId, ringNo: input.ringNo });
      return sendJson(res, 201, result);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof rules.RuleError) {
      const status = STATUS_BY_CODE[error.code] || 422;
      return sendJson(res, status, { error: error.code, details: error.details });
    }
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Hatchery release station listening on http://localhost:${port}`));
