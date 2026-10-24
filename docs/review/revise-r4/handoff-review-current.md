# 货记 · 当前有效交接

更新：2026-10-24。业务仓库 `forfree`，分支 `codex/huoji-mvp-foundation`，HEAD `9d07bc2`。用户已授权本地实施，四批本地实现与回归已完成；云数据、参考Excel和部署未修改。

当前验收见 `forfree/docs/QA-20261024.md`：CJS281/281、可运行TS201/201，类型/构建/发布检查通过；PG三项环境失败和Node版本差异仍在。新记录保存栏/折叠、AI与核对规则、列表日期范围/返回锚点/视图裁剪、v2下载/缓存、Excel派生公式/全图、快照文件复用均已实现。样表 `.data/outputs/product-record-20261024/`：2商户/4记录/9图，三份实际xlsx逐格/公式缓存/CRC检查通过。桌面打开、真实v2容器与原生/真机仍待验，不能沿用历史单块证据。

## 1 已正式收敛的方案

**权威文档：`report/SOLUTION.md` v1.3。** 先读该文，再看 `design.json`、示意与 `HANDOFF-TODO.md`。细节是本轮据用户边界确定的实施基线，不冒称用户逐条签字，也不含部署授权。

用户范围：采购人员自己记录/整理商家商品，最终产物是参考式商品 Excel。选商户 → 记录 → 保存 → 商品列表复看/补充/比较 → 日期/商户导出。

最终导航：商户 / 商品两个 tab，右上角进入设置；`pages/me/index` 复用为普通页，有原生返回。不做下单、采购单、批次、计入/取消/后补、商户确认、发送状态、客户 CRM/报价回选、收货、付款对账、团队共享、柜容预算、独立 Web 台。

本期明确取舍：

- 不新增整理队列路由，补资料复用 editor；“保存并继续”仅用于当前商户新品，不是下一条历史商品。
- 不建逐字段 AI 来源/采纳状态；已有补空+人工 confirmed，事实修改才撤销，不自动换商户/币种。
- 不新增 `recordedDate/itemNo/booth` 等伪字段，使用 ProductFields；记录日由 createdAt 得到，商户沿用 supplier。
- 核心字段前置，数量与包装折叠；未知可保存/导出，不要求下单或完整资料。
- 首期只导出日期/商户/all 或 confirmed，q/status/ids 不做；搜索/缺项不带入时页面明示。
- 十一列参考版式保留；派生 quantity/amount/cbm 公式待补，TOTAL 公式现有，不把它误称商品行已完成。
- 容器 v2 分段确定一条路线：640 KiB 原始块/≤900 KiB 实际预算、协议兼容、完整性和断点；不启用公网兜底。
- 索引复用及 60 MiB/七天缓存清理参数，保护草稿和引用；平台限制与手机表现实施时再测。

## 2 这轮完成什么

此前已读两份旧 handoff、tclaude 小程序 session 与第四轮资料；用现有 DeepSeek API 做通用搜索补核。185 条历史结论逐项处置，不是逐条全部重新核实；81 个历史问题 ID 保留追溯。旧扩大业务建议撤回。

本次继续读实际 editor、domain、draft、product-page、export、types、contracts、template、quotation-export、extraction、product-organize，确定真实字段和现有能力。本机再次运行草稿复现，确认卡片重开不读稿、后续保存删稿/照的机制。

产物：正式 SOLUTION v1.3、同步 REPORT/design/handoff/示意/验证，八张图是现有页面的状态（另设置），不是八条新增路由。源生成器取消逐字段 AI 候选来源/队列交互和伪字段。旧 v1.2 重建入口已停用，避免回写覆盖。

用户随后要求规划并开始：已新增 `forfree/docs/IMPLEMENTATION-PLAN.md`；第一批本地实现两 tab / 设置入口、卡片同 ID 草稿默认恢复、已保存版本只读、草稿快照与照片引用保护、名称可后补和帮助同步。新增回归，类型检查/构建/发布静态检查通过；完整测试结果与 PostgreSQL 环境缺口见 `final-v13/VALIDATION.md`。未部署或改线上数据。

方案与静态示意通过不表示业务已实现。不能从本次诊断推断真实使用频率；不以没有设备为借口继续泛化研究。

## 3 实施顺序

| 批次 | 范围 |
|---|---|
| 1 | 两 tab / 设置；草稿恢复/只读/快照/照片引用；名称后补（已本地实施，真机待验） |
| 2 | 容器兼容安全分段及嵌图；索引缓存（已本地实现，真实通道待验） |
| 3 | 字段/文字保存栏/展开偏好；核对与AI；返回分页锚点；日期范围和视图切换（已本地实现，原生待验） |
| 4 | 导出范围/件数/缺项/原文；公式与模板兼容；文件快照复用；Excel/请求回归（已本地实现，桌面/真机待验） |

验收清单见 SOLUTION 第 8 节与 HANDOFF-TODO。无旧订单总人日或默认下一期承诺；隐藏采购页/私有文件不删除。

## 4 历史现状与真机缺口

以 `forfree/docs/HANDOFF.md` 顶部 2026-10-21 16:03 最终交付与 2026-10-23 备份段为准，不依据下方早期“尚未部署”段判断。

历史记载后端 027 部署、229 TS/253 CJS、开发者工具真实容器合成 153,588 字节单段和桌面 Excel 通过。本轮未检查实时云健康。手机相机/键盘/弱网/大文件多段/微信分享仍未通过；上线需 iOS/Android 真机。新二维码不代表公众平台已选体验版。

参考原件在 `forfree/docs/`（Git 忽略）；本机只读结构 20 worksheet/16 drawing/90 media 不等于商户/商品图数。历史同构口径 10 商户/38 商品/44 图/10 TOTAL、96 箱/24,876 件/79,260/7.320 m³，旧采购假设 90 箱/70,491.60 不再作为硬指标。

## 5 生成与资料位置

- 当前正式源：`final-v13/REPORT.md`、`final-v13/HANDOFF-*.md`；`report/SOLUTION.md` 为手工权威规格。
- 同步：`node final-v13/finalize.mjs`，生成 design v1.3、安装当前报告/交接并同步旧 reader 的 source 镜像。
- 示意：`report/mockups/gen.py` → `gen_v12.py`（文件名历史保留，内容已为 v1.3），样式源 `style_v12.css`；不要手改生成 HTML。
- 一致性验证：`node final-v13/verify.mjs`；布局复用 `revise-r4/browser/verify.mjs`，完整说明 `final-v13/VALIDATION.md`。
- 来源：`report/SOURCE-AUDIT.md`、`report/INDUSTRY.md`、`revise-r4/claim-audit.json`；问题追溯 `revise-r4/issue-register.md`，不是全量排期。
- 旧资料完整备份：`revise-r4/backup/`、`report/mockups/historical/`。历史采集脚本不代表当前开发任务。

实际商品、商户、摊位、联系方式、图片只留本机；云验证用合成数据。不得打印 DeepSeek/云/会话凭据；不把私有内容发给搜索 API。当前官方页面没有取到正文，不宣称本轮已核实最新平台限制。
