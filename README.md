# 货记 · 市场看货助手

2026-10-18 当前版本：原生微信小程序14页，后端huoji-api-020已部署，前端最终上传记录以 [部署文档](docs/DEPLOYMENT.md) 和 [交接记录](docs/HANDOFF.md) 为准。主流程为现场图文记录 → 原始保存/后台AI补齐 → 按日期筛选与回收恢复 → 按商户导出并分享选品表 → 客户确认后下单。首版不显示Excel上传、独立按日回顾或下单整理入口。


面向义乌外贸采购员与商家：现场选品与多图记录 → 搜索筛选、收藏与商品对比 → 按商户整理采购数量和要求 → 核对与导出 Excel。公司常用表头、字体和列设置保存一次，后续采购整理复用。

现已由 Next.js 网页基础工程改为 **原生微信小程序 + 独立 Node.js API**。参考 keepfit 的页面/数据门面/草稿交互，但没有复制其云环境、账号或健康数据。本版本是可本地联调的工程，不代表完成微信真机、真实模型或上线验收。

## 架构

- `miniprogram/`：原生 JS / WXML / WXSS 页面、共享样式、API/会话/草稿数据层，微信开发者工具直接导入。
- `src/server/`：Fastify HTTP 入口、微信登录、请求契约、应用服务。默认仅监听 `127.0.0.1:3000`。
- `src/lib/`：商品类型与校验、保守文字规则、兼容模型接口、SQLite 仓储、图片存储接口、Excel 导出。
- `tests/`：规则、仓储、认证/跨用户授权、幂等与版本冲突、客户端 mock、构建后真实 HTTP 测试。

客户端 → API/会话门面 → 带 Bearer 会话的 HTTPS 请求 → 应用服务 → 仓储/图片/模型适配器。

微信 App Secret 和模型密钥只在后端环境变量。客户端不能直接读取 SQLite、Node 文件系统或调用持有私钥的模型接口。仓储、图片存储、身份提供商、模型提供商有替换边界；**当前运行实现仍是单实例 SQLite + 本地图片**，不是已接通的云数据库/对象存储。

## 本地开发

需要 Node.js 24+。在仓库根目录：

```bash
npm ci
npm run dev
```

把 `.env.example` 的内容配置到本机 `.env.local`（已忽略）。正常微信登录需要 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`。

没有正式凭据时可显式设置 `ALLOW_DEV_LOGIN=true`，保持 `HOST=127.0.0.1` 且不设置生产模式，再在小程序公开配置中开启开发登录。开发登录仅绑定固定本机测试账号，不能当作真实微信认证；生产模式或非本机监听会拒绝带此配置启动。

微信开发者工具导入 `miniprogram/`，工程已配置货记 AppID `wx676d460774c18c95`，`config.js` 中 `LOCAL_API_BASE_URL` 仅供桌面 develop 环境，`API_BASE_URL` 填已部署的公网货记后端域名。本项目当前域名由WorkBuddy托管，正式业务使用wx.cloud.callContainer；不回退公网wx.request，不关闭urlCheck。本机HTTP仅在明确USE_LOCAL_API桌面开发时使用。

```bash
npm run typecheck
npm test
npm run build
npm run test:api
```

`test:api` 在隔离临时数据库中预置测试会话，启动构建后的生产服务（默认 3197，可用 `TEST_PORT` 修改），通过实际 HTTP 验证任务创建、两件商品录入、全任务搜索筛选、按天回顾与日期标记、个人资料、收藏及版本冲突、评分/评价搜索和Excel、对比数据、版本修改、图片下载、带图/纯数据与确认范围导出、授权和退出；不连接真实微信/模型、不读取用户记录。`npm start` 运行构建产物；没有网页首页，`/health` 是存活探针。

## 体验版部署状态

2026-10-17 确认当前仅通过 WorkBuddy 发布前端，没有独立后端部署，原本机地址不能用于体验版。已改为独立登录入口并区分桌面与发布配置。当前 `API_BASE_URL` 留空，`npm run check:release` 会因域名未配置而失败；不能据此认为体验版已可登录。开发者工具已实际完成微信 code 经本机后端和共享云认证换码并返回原有六任务与草稿，尚无公网后端或体验版验收。部署准备见 `docs/DEPLOYMENT.md` 和根目录 Dockerfile。2026-10-17 已实际核实云资源：WorkBuddy原云可用；用户CloudBase环境已有PG，但云托管未开通、20M/60秒入口及新增计算费用不能直接满足40MB采购导入。费用确认前不部署临时磁盘版本；迁移方案和验收门禁见上述部署文档。`npm run pack:backend -- /绝对路径/新上传目录` 可生成不含本机凭据与内部采购数据的白名单后端源码。

## 页面与采购闭环

十个页面：独立登录、任务、选品、记录商品、对比、导出、我的、独立收藏页、采购整理和表格设置。采用近白底色与石墨色主操作，绿色只表达已核对状态。移除页面内的品牌、标语和重复标题；选品页以双列图片为主，录入页按供应商、现场记录、商品资料、规格包装分组，说明按需展开。

- 未登录只显示独立登录页，隐藏底部导航，业务页深链接也先经过登录拦截。登录成功进入任务，有效会话自动进入；退出、会话过期及服务端401统一返回登录页，不再在业务页重复提示。草稿保留在原账号下。
- 新任务创建后直接进入选品；保存并继续会保留供应商和联系方式，清空上一件商品与照片。
- 任务内搜索覆盖全部记录，支持名称、货号、供应商、联系方式、原始描述和备注；筛选全部、待核对、已确认、待询价。
- 选择两件商品并排核对采购条件，包含报价条款、起订量、外箱、体积、交期；不跨币种计算优劣。
- 增加货号、供应商联系方式、外箱尺寸、单箱体积(m³)、大货交期(天)、报价条款，兼容旧记录，未知值留空。
- 导出页显示真实记录预览、所选范围数量与未保存草稿；可打开或分享 Excel。
- 我的页面管理姓名、公司/商号、身份、电话、微信号和默认币种；按账号保存，离线可显示缓存资料和本机草稿。默认币种用于新建商品，不改已有记录。
- 任务页支持水平滑动日期条、记录点、前后一天、日历选择和全部任务。选品页日历图标与“我的 → 历史记录”进入按天回顾，按中国时间首次正式保存日期跨任务查询；可搜索、筛选、对比、修改和导出，Excel区分任务日期和记录日期。
- 选品页去除顶部模式标签。“我的 → 我的收藏”打开独立收藏页；商品图片上的爱心可直接收藏，收藏可跨任务搜索、筛选、对比和导出。
- 商品详情可填写1—5星和个人选品评价，再点当前星级取消评分；评价可搜索，评分和评价进入对比及Excel。修改收藏、评分或评价保留采购资料的核对状态，模型不生成个人评价。语音记录复用手机键盘语音输入。
- 我的 → 采购整理：导入供应商多 sheet 的人民币采购表，或从当前选品任务生成采购记录。按商户查看商品、图片、箱数、每箱数量、采购单价、体积、条码、运费和原表要求，逐件决定待核对、计入或取消。起订量不会作为采购数量，商品资料已确认也不代表采购已计入；运费未知留空，确认无额外运费后填0。
- 我的 → 表格设置：保存公司中文名、英文名、地址、电话/传真和单据标题五行表头，可逐行设字体、字号、加粗、对齐、行高、显示与顺序，并增加最多3行补充信息。中文与英文/数字常用字体、字段表头/商品/合计字号可分别设置；采购列可改名、调整列宽与顺序，非核心列可隐藏，最多8个文本扩展列可填写每件商品的客户货号、验货要求等信息。默认表头合并随商品列扩展；长标题按可见宽度换行。版式与打印另可设置跨列、边框、小数位、行高、纸张、方向、缩放和重复表头。
- 从 Excel 读取公司模板仅提供待保存的识别建议，适用于当前支持的五行公司信息及采购字段结构；不会自动保存模板或创建采购记录。保存后的模板供当前账号后续采购整理使用；已有记录可主动应用最新模板，保留已填写扩展列数据。模板按账号隔离，尚无公司管理员或多人共享模板。基础商品资料导出仍使用原有字段，采购模板用于采购整理导出。

采购整理导出在原工作簿后追加采购汇总、商品明细、商户要求和核对记录；原 sheet、图片和格式保留，新增明细按模板设置生成，数量、金额和体积使用可重算的公式。价格属于内部采购，不自动生成客户报价或发送订单。

原生开发者工具已检查页面布局，新增采购整理与表格设置已编译并实际查看。用户授权后，在本机当前账号新增4个演示任务、12件商品（2026-10-14至2026-10-16）和1条本机草稿，保留原有2个任务与个人资料；演示记录及Excel有标记，图片来自附件参考。真实采购表和公司模板另保存在本机忽略目录 `.data/`，不混入演示数据。截图见 `docs/screenshots/`，交互说明见 `docs/INTERACTION.md`。

`npm run seed:demo -- 已登录账号的ownerID` 可显式添加本机演示数据；脚本拒绝生产模式，写入前备份SQLite，重复执行不重复生成已有商品。草稿样本照片独立上传，当前演示设备另存持久照片；脚本不直接写入手机存储。该脚本没有公开API入口，正式账号不会自动播种。

## 数据、照片与可靠性

- 任务按登录用户隔离；商品、照片、图文整理和导出均校验归属，不接受请求体指定 owner。
- 默认 `.data/market.sqlite`、`.data/photos/`；部署必须将 `APP_DATA_DIR` 指向持久卷，备份数据库及图片。不要把本项目视为原片备份工具。
- 采购整理和原表保存在 `.data/procurement/`，公司模板在 `.data/procurement-templates/`，同样需要备份。当前采购导入限40MB，校验压缩包及实际解压大小；原文件重复导入按账号和内容摘要去重，修改携带版本避免覆盖。
- 数据库自动迁移旧数据。原无账号记录归到不可登录的 `__legacy__`，**不会自动让新用户访问**；需要归属确认后由管理员另行迁移，操作前备份。
- 单张上传最多 8MB，实际解码校验、旋转去元数据、长边最多1600px；每商品最多6图，数组顺序就是主图顺序。
- 先逐张上传暂存照片，再 JSON 保存商品。暂存和被移除的图片记录24小时过期；删除商品的图片立即不可读取。每小时及启动时清理过期记录，物理孤儿文件经过一小时保护期清理。可运行 `npm run maintenance` 手动清理。
- 新建任务、保存商品携带 UUID `requestKey`，同用户同键同内容可重放；异内容返回409。幂等回执与写入同事务持久化，不自动清除回执。编辑/删除携带 `version` 防止后写覆盖。
- 本机草稿按用户/任务/商品隔离，使用小程序持久文件保存新照片。只有明确服务端回执才视为正式保存；失败保留表单。草稿不是后台自动同步，联网后由用户重试；临时上传 ID 过期需要从本机图片重新上传。
- Excel 每商品一行，可选带首图或纯数据、全部商品或仅已确认；保留确认状态，不受列表搜索筛选影响。本机草稿不纳入导出。单任务导出最多500件、嵌图累计40MB，超过限制应拆分任务。

## 整理能力与边界

模型提供商由 `MODEL_PROVIDER` 选择：

- `openai`（未设置运行变量时的回退模式）：使用 `MODEL_API_KEY`、`MODEL_NAME`、`MODEL_BASE_URL` 的兼容 Chat Completions 接口；未配置时仅匹配明确文字，照片仅存档。
- `workbuddy`：使用与 keepfit 相同协议的共享云模型网关。后端配置 `WB_CLOUD_ENDPOINT`、`WB_CLOUD_PUBLISHABLE_KEY`、`WB_SESSION_ENCRYPTION_KEY` 和**货记的 `WECHAT_APP_ID`（`wx676d460774c18c95`，已完成平台换绑授权）**。公开应用标识不是模型私钥，不能填到 `MODEL_API_KEY`。`MODEL_NAME` 留空时动态选择目录内模型，图片场景只选择明确支持图片的模型。

WorkBuddy 模式只将微信 code 交给云登录接口兑换一次，不再同时直连微信重复兑换。云用户会话用服务端环境变量中的32字节随机密钥（64位十六进制）加密保存，按货记业务会话隔离，续期时校验同一用户，退出即撤销本地关联。不要复制健身用户 token，也不要跨用户共用网关会话；更换登录模式会产生独立身份，不自动合并历史记录。

共享网关支持完整 SSE 结果校验、JSON 模式兼容（含明确拒绝该参数的400/422）、最多3个模型候选、总30秒预算；认证/额度/网络错误不盲目重试。退出会撤销本地会话并取消运行中的网关传输，不能据此保证供应商端停止计费。适配基于 SDK 协议及模拟测试，新 AppID 已在本机后端完成真实登录换码，真实模型额度和识图效果仍待验证。默认不自动写入或启用旧云配置，未配置共享服务时不能执行图文识别。

用户已选择**只停健身入口，保留现有云应用、模型服务和健身数据**。货记 AppID `wx676d460774c18c95` 已于 2026-10-16 在 WorkBuddy 发布面板完成换绑授权，本项目目录已登记为该云应用的本地工程；`.env.local`（本机，不入库）已配置共享模型模式与会话加密密钥。平台绑定完成不等于运行验收：2026-10-17 已在桌面工具通过本机后端完成一次真实微信换码；共享模型额度/图片效果、HTTPS 域名部署与体验版真机验证仍待执行。

图片及描述会发送到配置的外部服务。未知值留空，不猜价格、尺寸、单件重量；起订量与每箱数量分开。所有结果需人工核对，不覆盖已有字段。

外部服务只允许公网 HTTPS，拒绝内网/保留地址及重定向，限制超时、响应体、输出长度；暂不支持内网模型。真实微信换码和图文模型效果尚未验收。没有团队共享权限、独立录音转写、支付、Agent、完整离线同步；旧的全局 `/api/demo` 已移除，避免混用模拟数据。

上线仍需要自己的 AppID/密钥、HTTPS 域名、持久卷、备份、运维/额度策略、微信隐私声明和审核，并完成开发者工具及真机验证。不要将开发登录或测试账号公开部署。

## API 契约

响应直接返回数据，错误为 `{ "error": { "code": "...", "message": "..." } }`。除 `/health`、`/api/config`、登录接口外都要求 `Authorization: Bearer <token>`；图片/Excel下载同样鉴权，密钥不得放 URL。

- `POST /api/auth/wechat {code}` → `{token,expiresAt,user:{id}}`；`GET /api/auth/me`；`POST /api/auth/logout`。
- `GET /api/projects`（包含汇总）；`GET /api/projects/:id/summary`；`POST /api/projects {requestKey,name,market,date}`。
- `GET /api/products?projectId=...&q=...&status=all|pending|confirmed|missingPrice&cursor=...&limit=...` → `{items,nextCursor,summary,matchedCount}`；`GET /api/products/:id`。
- `POST /api/photos`：multipart 单文件 `photo` → `{id,name,url}`。
- `POST /api/products {requestKey,projectId,id?,version?,fields,photoIds}` → 商品（含 `version`）。
- `DELETE /api/products/:id {version}`；`POST /api/products/:id/favorite {version,favorite}`。
- `GET /api/record-days` → `[{date,count}]`（中国时间首次保存日）；商品列表与导出也支持 `date=YYYY-MM-DD` 或 `favorite=yes`。
- `POST /api/extract {description,photoIds}` → `{fields,mode,warning}`。
- `GET /api/suppliers?projectId=...`；`GET /api/export?projectId=...&scope=all|confirmed&images=yes|no` → XLSX。
- `GET /api/procurement-template`；`POST /api/procurement-template {version,fields}`；`POST /api/procurement-template/import`（multipart `workbook`，仅返回模板建议）。
- `GET /api/procurement`；`POST /api/procurement/import`（multipart `workbook`）；`POST /api/procurement/from-project {projectId}`；`GET /api/procurement/:id`。
- `POST /api/procurement/:id/lines/:lineId {version,fields}`；`POST /api/procurement/:id/supplier {version,name,freight}`；`POST /api/procurement/:id/template {version}`；`POST /api/procurement/:id/source-selection {version}`。
- `GET /api/procurement/:id/export`、`/original`、`/images/:lineId/:index`；`DELETE /api/procurement/:id {version}`。上述接口均校验账号归属。

字段与请求的运行校验见 `src/lib/schema.ts` 和 `src/server/contracts.ts`。产品约束见 `docs/PRD.md`，后续联调见 `docs/HANDOFF.md`。
