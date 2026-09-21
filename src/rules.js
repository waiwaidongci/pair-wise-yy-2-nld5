// 孵化放行台：纯业务规则，不接触 HTTP 与文件系统。

export const EGG = { INCUBATING: "孵育中", CULL: "待淘汰", HATCHED: "已出壳", INVALID: "失效" };
export const CHICK = { PENDING: "待放行", READY: "可登记", ADMITTED: "已入场", ABNORMAL: "复核异常", INVALID: "失效" };
export const CANDLE = { DAY5_FERTILE: "受精", DAY5_INFERTILE: "未受精", DAY10_GOOD: "发育", DAY10_DEAD: "停育" };

const DAY5_RESULTS = new Set([CANDLE.DAY5_FERTILE, CANDLE.DAY5_INFERTILE]);
const DAY10_RESULTS = new Set([CANDLE.DAY10_GOOD, CANDLE.DAY10_DEAD]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class RuleError extends Error {
  constructor(code, details = []) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const str = v => (typeof v === "string" ? v.trim() : "");

function candleOf(egg, day) {
  return egg.candles.find(c => c.day === day) || null;
}

// 照蛋结论推导蛋状态：失效/已出壳为终态，其余按第5、第10日照蛋重算。
function recomputeEgg(egg) {
  if (egg.status === EGG.INVALID || egg.status === EGG.HATCHED) return;
  const c5 = candleOf(egg, 5);
  const c10 = candleOf(egg, 10);
  if ((c5 && c5.result === CANDLE.DAY5_INFERTILE) || (c10 && c10.result === CANDLE.DAY10_DEAD)) {
    egg.status = EGG.CULL;
    return;
  }
  egg.status = EGG.INCUBATING;
}

export function eggEligibleForHatch(egg) {
  const c5 = candleOf(egg, 5);
  const c10 = candleOf(egg, 10);
  return egg.status === EGG.INCUBATING
    && c5?.result === CANDLE.DAY5_FERTILE
    && c10?.result === CANDLE.DAY10_GOOD;
}

export function findEgg(db, eggId) {
  for (const clutch of db.clutches) {
    const egg = clutch.eggs.find(e => e.eggId === eggId);
    if (egg) return { clutch, egg };
  }
  return null;
}

export function findChick(db, chickId) {
  return db.chicks.find(c => c.chickId === chickId) || null;
}

// ---------- 档案 ----------

export function createPigeon(db, input) {
  const ringNo = str(input.ringNo);
  if (!ringNo) throw new RuleError("ring_no_required");
  if (db.pigeons.some(p => p.ringNo === ringNo)) throw new RuleError("ring_exists");
  const pigeon = {
    ringNo,
    owner: str(input.owner) || "未分配",
    fatherRing: str(input.fatherRing),
    motherRing: str(input.motherRing),
    color: str(input.color) || "未登记",
    loft: str(input.loft) || "未登记",
    vaccines: [],
    transfers: [],
    races: []
  };
  db.pigeons.unshift(pigeon);
  return pigeon;
}

// 亲鸽档案 / 血统更正：变更立即牵连未出壳蛋与待放行幼鸽。
export function correctPigeon(db, ringNo, patch, date = today()) {
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) throw new RuleError("pigeon_not_found");
  const changed = [];
  for (const field of ["color", "loft", "fatherRing", "motherRing"]) {
    if (patch[field] === undefined) continue;
    const value = str(patch[field]);
    if (pigeon[field] !== value) {
      pigeon[field] = value;
      changed.push(field);
    }
  }
  if (changed.length === 0) return { pigeon, changed, invalidatedEggs: [], invalidatedChicks: [] };
  const bloodline = changed.some(f => f === "fatherRing" || f === "motherRing");
  const reason = bloodline ? "血统更正" : "亲鸽档案更正";
  const invalidated = invalidateDependents(db, ringNo, reason, date);
  return { pigeon, changed, ...invalidated };
}

// 疫苗补录/更正同样触发重算。
export function addVaccine(db, ringNo, input, date = today()) {
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) throw new RuleError("pigeon_not_found");
  const name = str(input.name);
  if (!name) throw new RuleError("vaccine_name_required");
  const at = DATE_RE.test(str(input.date)) ? str(input.date) : date;
  pigeon.vaccines.push({ date: at, name });
  const invalidated = invalidateDependents(db, ringNo, "疫苗记录更正", date);
  return { pigeon, ...invalidated };
}

// ---------- 入孵批次 ----------

// 整批登记：先全部校验通过才落库；任一条不合格整批拒绝。
export function createIncubationBatch(db, rows, date = today()) {
  if (!Array.isArray(rows) || rows.length === 0) throw new RuleError("empty_batch");
  const errors = [];
  const groups = new Map();
  const batchTray = new Map();
  const existingClutch = new Set(db.clutches.map(c => c.clutchNo));
  const activeTrays = new Set();
  for (const clutch of db.clutches) {
    for (const egg of clutch.eggs) {
      if (egg.status === EGG.INCUBATING) activeTrays.add(egg.trayNo);
    }
  }

  rows.forEach((row, i) => {
    const where = `第${i + 1}行`;
    const clutchNo = str(row.clutchNo);
    const fatherRing = str(row.fatherRing);
    const motherRing = str(row.motherRing);
    const trayNo = str(row.trayNo);
    const incubationDate = str(row.incubationDate);
    const day5 = str(row.candleDay5);
    const day10 = str(row.candleDay10);

    for (const [field, value] of [["窝号", clutchNo], ["父鸽足环号", fatherRing], ["母鸽足环号", motherRing], ["盘位", trayNo]]) {
      if (!value) errors.push(`${where}：${field}缺失（窝号、亲鸽、盘位、入孵日与照蛋结果缺一不可）`);
    }
    if (!incubationDate) errors.push(`${where}：入孵日缺失`);
    else if (!DATE_RE.test(incubationDate)) errors.push(`${where}：入孵日格式应为 YYYY-MM-DD`);
    if (!day5) errors.push(`${where}：第五日照蛋结果缺失`);
    else if (!DAY5_RESULTS.has(day5)) errors.push(`${where}：第五日照蛋结果只能是「受精/未受精」`);
    if (day10) {
      if (!DAY10_RESULTS.has(day10)) errors.push(`${where}：第十日照蛋结果只能是「发育/停育」`);
      if (day5 === CANDLE.DAY5_INFERTILE) errors.push(`${where}：第五日已判未受精，不得再登记第十日照蛋`);
    }
    if (fatherRing && !db.pigeons.some(p => p.ringNo === fatherRing)) errors.push(`${where}：父鸽 ${fatherRing} 未建档`);
    if (motherRing && !db.pigeons.some(p => p.ringNo === motherRing)) errors.push(`${where}：母鸽 ${motherRing} 未建档`);
    if (fatherRing && motherRing && fatherRing === motherRing) errors.push(`${where}：父鸽与母鸽不能是同一只`);
    if (clutchNo && existingClutch.has(clutchNo)) errors.push(`${where}：窝号 ${clutchNo} 已存在`);
    if (trayNo) {
      if (batchTray.has(trayNo)) errors.push(`${where}：盘位 ${trayNo} 与${batchTray.get(trayNo)}重复占用`);
      else batchTray.set(trayNo, where);
      if (activeTrays.has(trayNo)) errors.push(`${where}：盘位 ${trayNo} 已被在孵蛋占用`);
    }
    if (clutchNo) {
      if (!groups.has(clutchNo)) groups.set(clutchNo, { fatherRing, motherRing, rows: [] });
      const group = groups.get(clutchNo);
      if (group.fatherRing && fatherRing && group.fatherRing !== fatherRing) errors.push(`${where}：窝号 ${clutchNo} 的父鸽前后不一致`);
      if (group.motherRing && motherRing && group.motherRing !== motherRing) errors.push(`${where}：窝号 ${clutchNo} 的母鸽前后不一致`);
      group.rows.push({ trayNo, incubationDate, day5, day10 });
    }
  });

  if (errors.length) throw new RuleError("batch_rejected", errors);

  const created = [];
  for (const [clutchNo, group] of groups) {
    const clutch = { clutchNo, fatherRing: group.fatherRing, motherRing: group.motherRing, createdAt: date, eggs: [] };
    group.rows.forEach((r, i) => {
      const eggId = `${clutchNo}-${String.fromCharCode(65 + i)}`;
      const candles = [{ day: 5, result: r.day5, recordedAt: date }];
      if (r.day10) candles.push({ day: 10, result: r.day10, recordedAt: date });
      const egg = {
        eggId, clutchNo, trayNo: r.trayNo, incubationDate: r.incubationDate,
        candles, status: EGG.INCUBATING, hatchDate: null, chickId: null,
        invalidatedAt: null, invalidateReason: null
      };
      recomputeEgg(egg);
      clutch.eggs.push(egg);
      created.push(egg);
    });
    db.clutches.push(clutch);
  }
  return { clutches: [...groups.keys()], eggs: created };
}

// 补照（一般用于第十日）。
export function addCandle(db, eggId, input, date = today()) {
  const found = findEgg(db, eggId);
  if (!found) throw new RuleError("egg_not_found");
  const { egg } = found;
  if (egg.status !== EGG.INCUBATING) throw new RuleError("egg_not_incubating", [`蛋当前状态为「${egg.status}」`]);
  const day = Number(input.day);
  const result = str(input.result);
  if (day !== 5 && day !== 10) throw new RuleError("invalid_candle_day");
  const allowed = day === 5 ? DAY5_RESULTS : DAY10_RESULTS;
  if (!allowed.has(result)) throw new RuleError("invalid_candle_result");
  if (candleOf(egg, day)) throw new RuleError("candle_already_recorded");
  if (day === 10) {
    const c5 = candleOf(egg, 5);
    if (!c5 || c5.result !== CANDLE.DAY5_FERTILE) throw new RuleError("day10_requires_fertile_day5");
  }
  if (day === 5) {
    const c10 = candleOf(egg, 10);
    if (c10 && result === CANDLE.DAY5_INFERTILE) throw new RuleError("day5_infertile_after_day10");
  }
  egg.candles.push({ day, result, recordedAt: DATE_RE.test(str(input.date)) ? str(input.date) : date });
  recomputeEgg(egg);
  return egg;
}

// ---------- 出壳与幼鸽复核 ----------

export function hatchEgg(db, eggId, input = {}, date = today()) {
  const found = findEgg(db, eggId);
  if (!found) throw new RuleError("egg_not_found");
  const { egg } = found;
  if (!eggEligibleForHatch(egg)) throw new RuleError("egg_not_hatchable", ["待淘汰蛋不占出壳名额；须第五日受精且第十日发育正常"]);
  egg.status = EGG.HATCHED;
  egg.hatchDate = DATE_RE.test(str(input.date)) ? str(input.date) : date;
  db.meta.chickSeq += 1;
  const chick = {
    chickId: `YG-${String(db.meta.chickSeq).padStart(4, "0")}`,
    eggId: egg.eggId,
    clutchNo: egg.clutchNo,
    fatherRing: found.clutch.fatherRing,
    motherRing: found.clutch.motherRing,
    hatchDate: egg.hatchDate,
    status: CHICK.PENDING,
    reviews: [],
    ringNo: null,
    admittedAt: null,
    invalidatedAt: null,
    invalidateReason: null
  };
  egg.chickId = chick.chickId;
  db.chicks.push(chick);
  return chick;
}

// 复核申请：申请号幂等（重复申请沿用首次结果）；两次正常须由不同人给出。
export function submitReview(db, chickId, input, date = today()) {
  const chick = findChick(db, chickId);
  if (!chick) throw new RuleError("chick_not_found");
  const applyNo = str(input.applyNo);
  const reviewer = str(input.reviewer);
  const result = str(input.result);
  if (!applyNo) throw new RuleError("apply_no_required");
  const previous = chick.reviews.find(r => r.applyNo === applyNo);
  if (previous) return { replayed: true, review: previous, chick };
  if (!reviewer) throw new RuleError("reviewer_required");
  if (result !== "正常" && result !== "异常") throw new RuleError("invalid_review_result");
  if (chick.status === CHICK.ADMITTED) throw new RuleError("chick_already_admitted");
  if (chick.status === CHICK.INVALID) throw new RuleError("chick_invalidated");
  if (chick.status === CHICK.ABNORMAL) throw new RuleError("chick_abnormal_locked");
  if (chick.status === CHICK.READY) throw new RuleError("chick_already_qualified");

  const normalReviews = chick.reviews.filter(r => r.result === "正常");
  if (result === "正常" && normalReviews.some(r => r.reviewer === reviewer)) {
    throw new RuleError("reviewer_must_change", ["出壳后须换人复核，复核人不能与首次相同"]);
  }
  const review = { applyNo, reviewer, result, date: DATE_RE.test(str(input.date)) ? str(input.date) : date };
  chick.reviews.push(review);
  if (result === "异常") {
    chick.status = CHICK.ABNORMAL;
  } else if (chick.reviews.filter(r => r.result === "正常").length >= 2) {
    chick.status = CHICK.READY;
  }
  return { replayed: false, review, chick };
}

// 两次正常复核后登记足环入场。
export function registerRing(db, chickId, input, date = today()) {
  const chick = findChick(db, chickId);
  if (!chick) throw new RuleError("chick_not_found");
  const ringNo = str(input.ringNo);
  if (!ringNo) throw new RuleError("ring_no_required");
  if (chick.status !== CHICK.READY) throw new RuleError("chick_not_ready", ["须经两名不同复核人各判定一次正常"]);
  if (db.pigeons.some(p => p.ringNo === ringNo) || db.chicks.some(c => c.ringNo === ringNo)) {
    throw new RuleError("ring_exists");
  }
  const father = db.pigeons.find(p => p.ringNo === chick.fatherRing);
  const mother = db.pigeons.find(p => p.ringNo === chick.motherRing);
  const pigeon = {
    ringNo,
    owner: father?.owner || mother?.owner || "育种棚",
    fatherRing: chick.fatherRing,
    motherRing: chick.motherRing,
    color: "待鉴定",
    loft: "幼鸽棚",
    vaccines: [],
    transfers: [],
    races: [],
    chickId: chick.chickId
  };
  db.pigeons.unshift(pigeon);
  chick.ringNo = ringNo;
  chick.status = CHICK.ADMITTED;
  chick.admittedAt = date;
  return { chick, pigeon };
}

// ---------- 更正牵连失效 ----------

function invalidateDependents(db, ringNo, reason, date) {
  const invalidatedEggs = [];
  const invalidatedChicks = [];
  for (const clutch of db.clutches) {
    if (clutch.fatherRing !== ringNo && clutch.motherRing !== ringNo) continue;
    for (const egg of clutch.eggs) {
      if (egg.status === EGG.HATCHED || egg.status === EGG.INVALID) continue;
      egg.status = EGG.INVALID;
      egg.invalidatedAt = date;
      egg.invalidateReason = reason;
      invalidatedEggs.push(egg.eggId);
    }
    for (const chick of db.chicks) {
      if (chick.clutchNo !== clutch.clutchNo) continue;
      if (chick.status === CHICK.ADMITTED || chick.status === CHICK.INVALID) continue;
      chick.status = CHICK.INVALID;
      chick.invalidatedAt = date;
      chick.invalidateReason = reason;
      invalidatedChicks.push(chick.chickId);
    }
  }
  return { invalidatedEggs, invalidatedChicks };
}

// ---------- 视图与统计（刷新后状态一律以此为准） ----------

function eggView(clutch, egg) {
  return {
    ...egg,
    fatherRing: clutch.fatherRing,
    motherRing: clutch.motherRing,
    day5: candleOf(egg, 5)?.result || null,
    day10: candleOf(egg, 10)?.result || null,
    eligible: eggEligibleForHatch(egg)
  };
}

export function stateView(db) {
  const clutches = db.clutches.map(c => ({
    clutchNo: c.clutchNo,
    fatherRing: c.fatherRing,
    motherRing: c.motherRing,
    createdAt: c.createdAt,
    eggs: c.eggs.map(e => eggView(c, e))
  }));
  const chicks = db.chicks.map(c => ({
    ...c,
    normalCount: c.reviews.filter(r => r.result === "正常").length
  }));
  const allEggs = clutches.flatMap(c => c.eggs);
  const stats = {
    clutches: clutches.length,
    traysOccupied: allEggs.filter(e => e.status === EGG.INCUBATING).length,
    cullPending: allEggs.filter(e => e.status === EGG.CULL).length,
    hatchReady: allEggs.filter(e => e.eligible).length,
    chicksPending: chicks.filter(c => c.status === CHICK.PENDING).length,
    chicksReady: chicks.filter(c => c.status === CHICK.READY).length,
    admitted: chicks.filter(c => c.status === CHICK.ADMITTED).length,
    invalidEggs: allEggs.filter(e => e.status === EGG.INVALID).length,
    invalidChicks: chicks.filter(c => c.status === CHICK.INVALID).length
  };
  return { pigeons: db.pigeons, clutches, chicks, stats };
}
