# 赛鸽孵化放行台

由血统环号登记站扩展而来，覆盖「窝次 → 盘位 → 照蛋 → 出壳 → 换人复核 → 足环放行」全流程。

运行：

```bash
npm start
```

访问 `http://localhost:3024`。

## 结构（规则 / 存档 / 页面分离）

- `src/rules.js` — 全部业务规则（纯函数，抛 `RuleError`）
- `src/store.js` — JSON 存档读写与结构迁移（`data/pigeons.json`）
- `server.js` — HTTP 路由，只做参数解析与错误映射
- `public/index.html` — 页面，经 `GET /api/state` 拉取全量状态，刷新后窝次、盘位、幼鸽状态一致

## 核心规则

- 每窝绑定亲鸽与唯一窝号；每枚蛋的盘位、入孵日、照蛋结果缺一不可；同盘位重复占用（批内或跨批）整批拒绝。
- 第五日未受精、第十日停育只转「待淘汰」，不占出壳名额（每窝名额 2），确认淘汰后释放盘位。
- 亲鸽血统、疫苗或归属更正后，其未出壳蛋与待放行幼鸽立即失效并重算（留 `revision` / `recalculatedAt` 痕迹）。
- 出壳需登记操作人；复核须换人（不能是记录人、不可重复），正常两次才可登记足环入场；重复放行申请沿用首次结果（幂等）。

## 主要接口

- `POST /api/clutches` 新建窝次（整批校验）
- `POST /api/clutches/:clutchNo/eggs/:eggId/candling|hatch|cull` 照蛋 / 出壳 / 淘汰
- `POST /api/squabs/:id/reviews` 换人复核；`POST /api/squabs/:id/release` 足环放行
- `POST /api/pigeons/:ring/corrections` 档案更正（联动失效重算）；转让、疫苗录入同样触发
