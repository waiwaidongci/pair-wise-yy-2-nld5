# 赛鸽孵化放行台

由原「赛鸽血统环号登记站」扩展而来。规则、存档、页面三者分离：

| 文件 | 职责 |
| --- | --- |
| `src/rules.js` | 纯业务规则（无 HTTP、无文件 IO），所有状态推导的唯一来源 |
| `src/store.js` | 存档：`data/hatchery.json` 持久化 + `data/events.jsonl` 只追加操作流水 |
| `public/index.html` | 页面（静态，状态全部来自 `/api/state`，刷新后与服务端一致） |
| `server.js` | 仅做 HTTP 路由与流水归档 |

## 运行

```bash
npm start   # http://localhost:3024
```

首次启动自动把旧档 `data/pigeons.json` 的亲鸽档案迁移进新库，孵化域从零开始。

## 业务规则

1. **窝次绑定**：每窝蛋绑定父鸽、母鸽（须已建档）和唯一窝号；同窝多枚蛋共用亲鸽，窝号/亲鸽不一致整批拒绝。
2. **整批入孵**：每枚蛋的盘位、入孵日、第五日照蛋结果缺一不可；第十日可入孵时登记或之后补照。
3. **盘位唯一**：批内盘位重复，或盘位已被在孵蛋占用 → 整批拒绝，不落任何数据。蛋转待淘汰、出壳或失效后释放盘位。
4. **照蛋淘汰**：第五日「未受精」或第十日「停育」→ 状态转「待淘汰」，立即释放盘位，且不占出壳名额。只有第五日受精 + 第十日发育才可确认出壳。
5. **更正失效重算**：亲鸽档案（羽色/棚号）、血统（父母环号）或疫苗记录更正后，其名下所有未出壳蛋与未入场（含待放行、可登记、复核异常）幼鸽立即失效，盘位与名额释放；已入场足环鸽不受影响。
6. **换人复核**：出壳幼鸽需两次复核结论均为「正常」，且两次复核人不能相同；任一「异常」即锁定不得入场。
7. **申请幂等**：复核按申请号去重，同一申请号重复提交直接沿用首次结论，不重复计数。
8. **足环入场**：两次正常后方可登记足环，足环号全局唯一，登记后成为正式鸽只档案。
9. **可追溯**：所有操作写入 `data/events.jsonl` 流水（含整批拒绝以外的成功动作、重复申请回放、更正牵连范围）。

## 接口

- `GET /api/state` — 窝次、盘位、蛋、幼鸽、亲鸽与统计（页面唯一数据源）
- `GET /api/events` — 操作流水
- `POST /api/incubations` — 整批入孵 `{ rows: [{ clutchNo, fatherRing, motherRing, trayNo, incubationDate, candleDay5, candleDay10? }] }`
- `POST /api/pigeons` — 新建亲鸽档案
- `POST /api/pigeons/:ringNo/corrections` — 档案/血统更正（触发失效重算）
- `POST /api/pigeons/:ringNo/vaccines` — 疫苗补录（触发失效重算）
- `POST /api/eggs/:eggId/candles` — 补照 `{ day: 10, result: "发育|停育" }`
- `POST /api/eggs/:eggId/hatch` — 确认出壳
- `POST /api/chicks/:chickId/reviews` — 复核 `{ applyNo, reviewer, result }`
- `POST /api/chicks/:chickId/ring` — 登记足环入场 `{ ringNo }`
