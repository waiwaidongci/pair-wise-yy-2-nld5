// HTTP 层：只做路由与参数解析，规则在 src/rules.js，存档在 src/store.js，页面在 public/index.html。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDb, saveDb } from "./src/store.js";
import {
  RuleError,
  createClutch,
  updateCandling,
  hatchEgg,
  cullEgg,
  reviewSquab,
  releaseSquab,
  correctPigeon,
  invalidateForPigeon,
  recompute
} from "./src/rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3024);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function sendError(res, error) {
  if (error instanceof RuleError) {
    const status = error.code.endsWith("not_found") ? 404 : 409;
    return sendJson(res, status, { error: error.code, message: error.message, details: error.details || null });
  }
  sendJson(res, 500, { error: "internal_error", message: error.message });
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") {
      const page = await readFile(join(__dirname, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    // 整站状态：页面刷新后窝次、盘位、幼鸽状态以此为准。
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, db);

    if (req.method === "GET" && url.pathname === "/api/pigeons") return sendJson(res, 200, db.pigeons);
    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists", message: "足环号已存在" });
      const pigeon = { ...input, vaccines: [], transfers: [], races: [] };
      db.pigeons.unshift(pigeon);
      await saveDb(db);
      return sendJson(res, 201, pigeon);
    }

    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found", message: "鸽只不存在" });
    }

    // 档案更正（血统/疫苗/归属等）：联动未出壳蛋与待放行幼鸽失效重算。
    const correctionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/corrections$/);
    if (correctionMatch && req.method === "POST") {
      const result = correctPigeon(db, decodeURIComponent(correctionMatch[1]), await body(req));
      await saveDb(db);
      return sendJson(res, 200, result);
    }

    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const pigeon = db.pigeons.find(item => item.ringNo === decodeURIComponent(actionMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found", message: "鸽只不存在" });
      const input = await body(req);
      if (actionMatch[2] === "transfers") {
        const transfer = { date: input.date || new Date().toISOString().slice(0, 10), from: pigeon.owner, to: input.to };
        pigeon.owner = input.to;
        pigeon.transfers.push(transfer);
      }
      if (actionMatch[2] === "races") pigeon.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
      if (actionMatch[2] === "vaccines") pigeon.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
      // 转让与疫苗属于档案更正：未出壳蛋及待放行幼鸽立即失效重算。
      const invalidated = invalidateForPigeon(db, pigeon.ringNo);
      const recalculated = recompute(db);
      await saveDb(db);
      return sendJson(res, 200, { pigeon, invalidated, recalculated });
    }

    if (req.method === "POST" && url.pathname === "/api/clutches") {
      const clutch = createClutch(db, await body(req));
      await saveDb(db);
      return sendJson(res, 201, clutch);
    }
    if (req.method === "GET" && url.pathname === "/api/clutches") return sendJson(res, 200, db.clutches);

    const eggMatch = url.pathname.match(/^\/api\/clutches\/(.+)\/eggs\/(.+)\/(candling|hatch|cull)$/);
    if (eggMatch && req.method === "POST") {
      const clutchNo = decodeURIComponent(eggMatch[1]);
      const eggId = decodeURIComponent(eggMatch[2]);
      const input = await body(req);
      let result;
      if (eggMatch[3] === "candling") result = updateCandling(db, clutchNo, eggId, input);
      if (eggMatch[3] === "hatch") result = hatchEgg(db, clutchNo, eggId, input);
      if (eggMatch[3] === "cull") result = cullEgg(db, clutchNo, eggId);
      await saveDb(db);
      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/api/squabs") return sendJson(res, 200, db.squabs);
    const squabMatch = url.pathname.match(/^\/api\/squabs\/(.+)\/(reviews|release)$/);
    if (squabMatch && req.method === "POST") {
      const squabId = decodeURIComponent(squabMatch[1]);
      const input = await body(req);
      const result = squabMatch[2] === "reviews" ? reviewSquab(db, squabId, input) : releaseSquab(db, squabId, input);
      await saveDb(db);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(port, () => console.log(`Racing pigeon hatchery release app listening on http://localhost:${port}`));
