# 正式方案 v1.3 与四批本地实施验证

## 当前交付 · 2026-10-24

四批本地实现与回归已完成，准确复跑命令见 `forfree/docs/QA-20261024.md`。CJS281/281、可运行TS201/201，0跳过；类型/构建/发布静态检查与diff检查通过。完整`npm test`仍有三项PG环境失败，明确排除两个PG文件后另跑TS，不能称完整入口全绿。Node22与要求>=24的差异仍在。

新增17项本轮场景：增量SHA/Unicode、四块下载/坏块/断点/同任务恢复/旧协议边界、缓存去重/账号/引用/LRU/七天；文件快照与版本变化、预览件数/模板原文；事实与偏好/同值输入、折叠偏好、第40件返回、日期范围和200件长备注视图≤256KiB。后端新增派生公式/重排/零缓存XML/保存模板与AI事实no-op验证，云接口v2模拟鉴权/元信息/offset/hash检查。图片GET独立限流，无数据库新字段或迁移。

实际合成xlsx三份在 `.data/outputs/product-record-20261024/`，2店4记录9图；逐格/公式缓存/ZIP CRC/原数据不变通过。未读取或上传真实参考表，无网络或数据库写入。桌面Excel/WPS打开和真机分享未验，本环境没有相应软件/设备。保守640KiB块/60MiB缓存预算不冒称最新平台限额或磁盘剩余空间；官方页面本轮未获取可读正文。

HEAD仍9d07bc2，未提交/部署/上传微信/更改云数据。本轮未重跑旧静态原型浏览器截图，将其保持为历史示意；当前实际业务WXML/事件绑定测试通过，不等于原生编译。下方为第一批与更早历史验证。

## 历史：第一批本地结果

## 最新结果 · 2026-10-24

用户最终确定商户 / 商品两 tab、右上角普通设置页，并授权本地实施。本段覆盖下方“未改业务代码/工作树干净/三 tab”的历史阶段描述，不删除历史证据。

- 第一批代码已改：导航/设置、同 ID 草稿默认恢复、云版本只读、写入/清理快照比较、跨稿/活跃编辑器照片引用保护、名称后补和帮助同步。后续分段/缓存/表单/核对/AI/返回/Excel 新公式与文件复用仍待实施。
- 新增11项回归。全量 CJS **264/264** 通过、0跳过；可运行 TS **198/198** 通过。`npm test` 完整入口实际失败：三个 PG16 测试因 `/opt/homebrew/bin/pg_ctl` 或 `initdb` ENOENT，本机无 PostgreSQL；CJS 被短路后单独执行，TS 明确排除 `cloud-tasks-pg.test.ts`、`date-range-sql.test.ts` 后确认其余通过。不能称完整入口全绿。
- `npm run typecheck`、`build`、`check:release` 与 `git diff --check` 通过。当前 Node22.23.2，而 engines>=24；按锁文件安装，无 lockfile 修改，不擅改环境/线上配置。
- 编辑/商户/商品/帮助 WXML 结构检查，以及既有全部事件绑定检查通过。结构检查先规范化 WXML 表达式与布尔属性；不是微信原生编译或真机验收。
- 当前 design 与实际 app.json 两 tab 一致；设置是既有 `pages/me/index`，不新增路由或数据字段。九组规格/字段/文档检查通过；业务未提交状态如实记录在 validation.json。
- 浏览器33项（九屏×三宽度27、目录2、历史脱敏4）通过；新增主页面两 tab / 设置入口、普通页面无 tabBar / 有返回验证。三组对照与六项展开检查通过。人工查看商户与设置截图；示意仍不连接业务数据。
- 当前文档/HTML隐私与业务范围扫描通过：0电话样式泄漏、0越界交易操作；历史81问题/185研究条目保留。原三 tab 源已同步，历史副本保留不当现行方案。
- HEAD `9d07bc2` 不变，工作树包含未提交第一批修改。未部署/迁移/改云数据/真实参考 Excel/既有模板，未上传微信代码或生成新体验版。没有新的实时云健康、真正大文件多块容器或 iOS/Android 真机证据。

本地业务命令：

```bash
npm test
# 上面的完整入口如实记录PG路径失败；以下明确补跑可运行项。
mapfile -t huoji_ts_files < <(rg --files tests | rg '\.test\.ts$' | rg -v '^tests/(cloud-tasks-pg|date-range-sql)\.test\.ts$')
./node_modules/.bin/tsx --test --test-reporter=dot "${huoji_ts_files[@]}"
node --test --test-reporter=spec tests/*.test.cjs
npm run typecheck
npm run build
npm run check:release
git diff --check
```

## 历史：实施前方案验证

日期：2026-10-24。验证对象为方案、字段映射、当前代码事实、生成文档及静态示意。**业务修复、云部署和真机验收均未进行。**

### 当时已完成

- 正式方案 `report/SOLUTION.md`：223 行范围、页面、字段、核对、草稿、导出、技术路线与分批验收；优先于旧提案，未冒称用户逐项签字。
- `design.json` v1.3：三 tab，复用三类既有数据；八个页面状态均对应现有路由/弹层，不新增业务路由。
- 27 个真实 ProductFields 完整映射；核对撤销/保留字段覆盖且无伪键；参考十一列顺序和 `cartonQty→pcsPerCarton` 对齐当前模板。
- 使用现有本机纯函数验证 unknown/null、显式 quantity=0、箱数×每箱、金额、每箱数不得零、条码前导零，以及北京时间跨日边界。这里只验证当前语义，不冒称新增 Excel 公式已实现。
- 源代码检查确认当前商品行派生数值和唯一 TOTAL 公式写入，双方仍为旧 4 MiB 下载；正式方案明确新行为待实施。
- 字段/当前实现/协议与缓存参数/文档镜像/路由一致性共九组通过：`validation.json`。
- 静态页面九屏 × 320/375/414：27 次全部通过，无横向溢出、胶囊冲突、缺图、坏链接或小于 44px 主热区；最小字体 12px。
- 目录 320/1280 两次，四份历史图 DOM 脱敏，三组对照重生成；九张 750×1624 截图非空。
- 录入/导出包装、原文折叠全部展开，三宽度共六份滚到底截图；额外检查横向溢出、热区、缺图，见 `expanded-results.json`。
- 当前方案、报告、设计、handoff 与 HTML 扫描无已知私有代号或电话样式泄漏，无下单操作。历史 81 问题 ID /185 研究处置保留，不按全量执行。
- 新旧生成源对齐，历史 v1.2 覆盖入口停用。正文 v1.2 版备份 `baseline-v12/`，更早全稿/图在 `../revise-r4/backup/`。
- 当前业务仓库 HEAD `9d07bc2`，`git status --porcelain` 为空。
- 草稿丢失本机模拟再次复现：卡片重开未读取同 ID 草稿，后续 finish 删除稿及本机图；这是待修证据，不是业务验证通过。

布局结果：`../revise-r4/validation.json`、`browser-results.json`、`comparison-results.json`；窄屏展开截图：`../revise-r4/browser-shots/`。字段结果：本目录 `validation.json`。

### 当时不得宣称通过

新草稿恢复、v2 分段与哈希、缓存引用保护、字段/核对/AI修改、返回锚点、商品范围 UI、Excel 新公式与文件复用，尚未实施。

没有真实大文件多块容器、手机系统相机/键盘/弱网/微信分享/iOS Android 验收，也没有新云健康检查、部署或体验版选择。本轮官方页面请求未取得正文；保守参数不是重新核实的最新平台上限。

静态图包括编辑/导出状态，不存数据。无图/重排/币种/长备注及公式缓存的新行为必须在实施后以真实 XLSX 验证。

## 当前文档重生成与检查

从 `/data/workspace/hanpengyan/.huoji-review` 执行，各命令单独确认结果：

```bash
node final-v13/finalize.mjs
python3 report/mockups/gen.py
python3 report/mockups/compare.py
node revise-r4/browser/verify.mjs
node revise-r4/browser/compare-shots.mjs
node final-v13/verify.mjs
node revise-r4/validate.mjs
```

`final-v13/finalize.mjs` 安装当前报告/交接，重建 v1.3 设计，同步旧 source 镜像。示意主生成器文件名 `gen_v12.py` 历史保留，内容已 v1.3；不要运行停用的 `revise-r4/revise.mjs` 覆盖方案。
