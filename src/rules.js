// 孵化放行台业务规则：纯函数，不触碰存储与 HTTP。
export const CLUTCH_HATCH_QUOTA = 2; // 每窝出壳名额
export const TRAY_ACTIVE_STATUSES = new Set(["incubating", "pending_cull"]); // 仍占盘位的状态
export const CANDLING_DAY5 = new Set(["fertile", "infertile"]);
export const CANDLING_DAY10 = new Set(["developing", "stopped"]);

export class RuleError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

// 第五日未受精、第十日停育 → 只转待淘汰；否则在孵。出壳/淘汰为终态，不在此推导。
export function deriveEggStatus(egg) {
  if (egg.candling.day5 === "infertile") return "pending_cull";
  if (egg.candling.day10 === "stopped") return "pending_cull";
  return "incubating";
}

export function normalReviewCount(squab) {
  return squab.reviews.filter(item => item.result === "normal").length;
}

export function findClutch(db, clutchNo) {
  const clutch = db.clutches.find(item => item.clutchNo === clutchNo);
  if (!clutch) throw new RuleError("clutch_not_found", `窝号 ${clutchNo} 不存在`);
  return clutch;
}

export function findSquab(db, squabId) {
  const squab = db.squabs.find(item => item.squabId === squabId);
  if (!squab) throw new RuleError("squab_not_found", `幼鸽 ${squabId} 不存在`);
  return squab;
}

function findEgg(clutch, eggId) {
  const egg = clutch.eggs.find(item => item.eggId === eggId);
  if (!egg) throw new RuleError("egg_not_found", `蛋 ${eggId} 不存在于窝 ${clutch.clutchNo}`);
  return egg;
}

// 当前仍被占用的盘位（在孵 + 待淘汰），出壳与已淘汰释放盘位。
export function occupiedTraySlots(db) {
  const map = new Map();
  for (const clutch of db.clutches) {
    for (const egg of clutch.eggs) {
      if (TRAY_ACTIVE_STATUSES.has(egg.status)) {
        map.set(egg.traySlot, { clutchNo: clutch.clutchNo, eggId: egg.eggId });
      }
    }
  }
  return map;
}

// 新建一窝：盘位、入孵日、照蛋结果缺一不可；同盘位重复占用（批内或跨批）整批拒绝。
export function createClutch(db, input) {
  const clutchNo = String(input.clutchNo || "").trim();
  const fatherRing = String(input.fatherRing || "").trim();
  const motherRing = String(input.motherRing || "").trim();
  const eggs = Array.isArray(input.eggs) ? input.eggs : [];
  const problems = [];
  if (!clutchNo) problems.push("缺少唯一窝号");
  if (clutchNo && db.clutches.some(item => item.clutchNo === clutchNo)) problems.push(`窝号 ${clutchNo} 已存在`);
  if (!db.pigeons.some(item => item.ringNo === fatherRing)) problems.push(`父鸽 ${fatherRing || "(空)"} 未登记`);
  if (!db.pigeons.some(item => item.ringNo === motherRing)) problems.push(`母鸽 ${motherRing || "(空)"} 未登记`);
  if (!eggs.length) problems.push("至少需要一枚蛋");
  const occupied = occupiedTraySlots(db);
  const batchSlots = new Set();
  eggs.forEach((egg, index) => {
    const label = `第${index + 1}枚蛋`;
    const traySlot = String(egg.traySlot || "").trim();
    const day5 = egg.candling?.day5 || null;
    const day10 = egg.candling?.day10 || null;
    if (!traySlot) problems.push(`${label}缺少盘位`);
    if (!egg.incubationStart) problems.push(`${label}缺少入孵日`);
    if (!day5) problems.push(`${label}缺少照蛋结果`);
    if (day5 && !CANDLING_DAY5.has(day5)) problems.push(`${label}第五日照蛋结果无效`);
    if (day10 && !CANDLING_DAY10.has(day10)) problems.push(`${label}第十日照蛋结果无效`);
    if (traySlot) {
      if (occupied.has(traySlot)) problems.push(`盘位 ${traySlot} 已被窝 ${occupied.get(traySlot).clutchNo} 占用`);
      if (batchSlots.has(traySlot)) problems.push(`盘位 ${traySlot} 在本批内重复占用`);
      batchSlots.add(traySlot);
    }
  });
  if (problems.length) throw new RuleError("clutch_rejected", `整批拒绝：${problems.join("；")}`, problems);
  const clutch = {
    clutchNo,
    fatherRing,
    motherRing,
    createdAt: today(),
    revision: 0,
    eggs: eggs.map((egg, index) => {
      const item = {
        eggId: String(egg.eggId || `${clutchNo}-${index + 1}`),
        traySlot: String(egg.traySlot).trim(),
        incubationStart: egg.incubationStart,
        candling: { day5: egg.candling?.day5 || null, day10: egg.candling?.day10 || null },
        status: "incubating",
        stale: false,
        revision: 0,
        recalculatedAt: null,
        hatchedAt: null,
        squabId: null
      };
      item.status = deriveEggStatus(item);
      return item;
    })
  };
  db.clutches.unshift(clutch);
  return clutch;
}

// 补录/更正照蛋结果：立即按规则重推状态（未受精/停育 → 待淘汰）。
export function updateCandling(db, clutchNo, eggId, candling) {
  const clutch = findClutch(db, clutchNo);
  const egg = findEgg(clutch, eggId);
  if (egg.status === "hatched" || egg.status === "culled") {
    throw new RuleError("egg_closed", `蛋 ${eggId} 已${egg.status === "hatched" ? "出壳" : "淘汰"}，不能再照蛋`);
  }
  if (candling.day5 !== undefined && candling.day5 !== null) {
    if (!CANDLING_DAY5.has(candling.day5)) throw new RuleError("candling_invalid", "第五日照蛋结果只能是 fertile/infertile");
    egg.candling.day5 = candling.day5;
  }
  if (candling.day10 !== undefined && candling.day10 !== null) {
    if (!CANDLING_DAY10.has(candling.day10)) throw new RuleError("candling_invalid", "第十日照蛋结果只能是 developing/stopped");
    egg.candling.day10 = candling.day10;
  }
  egg.status = deriveEggStatus(egg);
  egg.revision += 1;
  return { clutch, egg };
}

// 出壳：待淘汰蛋不占出壳名额也不能出壳；名额满则拒绝。
export function hatchEgg(db, clutchNo, eggId, { operator } = {}) {
  const clutch = findClutch(db, clutchNo);
  const egg = findEgg(clutch, eggId);
  if (egg.status === "hatched") return { clutch, egg, squab: findSquab(db, egg.squabId), reused: true };
  if (egg.status === "culled") throw new RuleError("egg_culled", `蛋 ${eggId} 已淘汰，不能出壳`);
  if (egg.status === "pending_cull") throw new RuleError("egg_pending_cull", `蛋 ${eggId} 未受精或停育，转待淘汰，不能占出壳名额`);
  const hatchedCount = clutch.eggs.filter(item => item.status === "hatched").length;
  if (hatchedCount >= CLUTCH_HATCH_QUOTA) throw new RuleError("hatch_quota_full", `窝 ${clutchNo} 出壳名额(${CLUTCH_HATCH_QUOTA})已满`);
  if (!operator || !String(operator).trim()) throw new RuleError("operator_required", "出壳需登记操作人，便于换人复核");
  const squab = {
    squabId: `${clutchNo}-${egg.eggId}-S`,
    clutchNo,
    eggId: egg.eggId,
    fatherRing: clutch.fatherRing,
    motherRing: clutch.motherRing,
    hatchedAt: today(),
    recordedBy: String(operator).trim(),
    reviews: [],
    status: "pending_release",
    stale: false,
    revision: 0,
    recalculatedAt: null,
    ringNo: null
  };
  egg.status = "hatched";
  egg.hatchedAt = squab.hatchedAt;
  egg.squabId = squab.squabId;
  egg.revision += 1;
  db.squabs.unshift(squab);
  return { clutch, egg, squab, reused: false };
}

// 待淘汰蛋确认淘汰，释放盘位。
export function cullEgg(db, clutchNo, eggId) {
  const clutch = findClutch(db, clutchNo);
  const egg = findEgg(clutch, eggId);
  if (egg.status !== "pending_cull") throw new RuleError("egg_not_cullable", `蛋 ${eggId} 当前状态为 ${egg.status}，只有待淘汰蛋可执行淘汰`);
  egg.status = "culled";
  egg.revision += 1;
  return { clutch, egg };
}

// 换人复核：复核人不能是出壳记录人，也不能重复；两次“正常”才具备放行资格。
export function reviewSquab(db, squabId, { reviewer, result } = {}) {
  const squab = findSquab(db, squabId);
  if (squab.status === "released") throw new RuleError("squab_released", `幼鸽 ${squabId} 已放行，不能再复核`);
  const name = String(reviewer || "").trim();
  if (!name) throw new RuleError("reviewer_required", "复核人不能为空");
  if (name === squab.recordedBy) throw new RuleError("reviewer_same_as_recorder", "需换人复核：复核人不能是出壳记录人");
  if (squab.reviews.some(item => item.reviewer === name)) throw new RuleError("reviewer_duplicated", `复核人 ${name} 已复核过，请换人`);
  if (!["normal", "abnormal"].includes(result)) throw new RuleError("review_invalid", "复核结果只能是 normal/abnormal");
  squab.reviews.push({ reviewer: name, result, date: today() });
  squab.revision += 1;
  return squab;
}

// 登记足环放行：重复申请沿用首次结果（幂等）。
export function releaseSquab(db, squabId, { ringNo, owner } = {}) {
  const squab = findSquab(db, squabId);
  if (squab.status === "released") {
    const existing = db.releases.find(item => item.squabId === squabId);
    return { squab, release: existing, reused: true };
  }
  const normals = normalReviewCount(squab);
  if (normals < 2) throw new RuleError("review_not_met", `幼鸽 ${squabId} 正常复核 ${normals}/2 次，暂不能登记足环入场`);
  const ring = String(ringNo || "").trim();
  if (!ring) throw new RuleError("ring_required", "放行需登记足环号");
  if (db.pigeons.some(item => item.ringNo === ring) || db.releases.some(item => item.ringNo === ring)) {
    throw new RuleError("ring_exists", `足环号 ${ring} 已存在`);
  }
  const release = {
    releaseId: `REL-${squabId}`,
    squabId,
    ringNo: ring,
    date: today(),
    reviewCount: normals,
    decision: "approved"
  };
  db.releases.push(release);
  squab.status = "released";
  squab.ringNo = ring;
  squab.revision += 1;
  db.pigeons.unshift({
    ringNo: ring,
    owner: String(owner || "").trim() || "待分配",
    fatherRing: squab.fatherRing,
    motherRing: squab.motherRing,
    color: "",
    loft: "孵化放行台",
    vaccines: [],
    transfers: [],
    races: []
  });
  return { squab, release, reused: false };
}

// 亲鸽、疫苗或血统更正后：该鸽作为亲鸽的未出壳蛋与待放行幼鸽立即失效，随后重算。
export function invalidateForPigeon(db, ringNo) {
  let marked = 0;
  for (const clutch of db.clutches) {
    if (clutch.fatherRing !== ringNo && clutch.motherRing !== ringNo) continue;
    for (const egg of clutch.eggs) {
      if (egg.status === "incubating" || egg.status === "pending_cull") {
        if (!egg.stale) { egg.stale = true; marked += 1; }
      }
    }
    for (const squab of db.squabs) {
      if (squab.clutchNo === clutch.clutchNo && squab.status === "pending_release" && !squab.stale) {
        squab.stale = true;
        marked += 1;
      }
    }
  }
  return marked;
}

// 重算：按现有照蛋/复核数据重新推导状态，并留下重算痕迹（revision、recalculatedAt）。
export function recompute(db) {
  let eggs = 0;
  let squabs = 0;
  for (const clutch of db.clutches) {
    for (const egg of clutch.eggs) {
      if (egg.stale) {
        egg.status = deriveEggStatus(egg);
        egg.stale = false;
        egg.revision += 1;
        egg.recalculatedAt = today();
        eggs += 1;
      }
    }
  }
  for (const squab of db.squabs) {
    if (squab.stale) {
      squab.stale = false;
      squab.revision += 1;
      squab.recalculatedAt = today();
      squabs += 1;
    }
  }
  return { eggs, squabs };
}

// 档案更正（血统/归属/羽色/棚号/疫苗），更正后联动失效重算。
export function correctPigeon(db, ringNo, patch = {}) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) throw new RuleError("pigeon_not_found", `鸽只 ${ringNo} 不存在`);
  for (const field of ["owner", "color", "loft", "fatherRing", "motherRing"]) {
    if (patch[field] !== undefined) pigeon[field] = String(patch[field] ?? "").trim();
  }
  if (Array.isArray(patch.vaccines)) {
    pigeon.vaccines = patch.vaccines.map(item => ({ date: item.date || today(), name: String(item.name || "") }));
  }
  const invalidated = invalidateForPigeon(db, ringNo);
  const recalculated = recompute(db);
  return { pigeon, invalidated, recalculated };
}
