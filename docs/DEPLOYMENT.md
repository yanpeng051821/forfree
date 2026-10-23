# 当前运行与发布 · 2026-10-21

历史迁移方案已保存在HANDOFF.md的日期记录。本页描述当前实际部署，不能再按旧“API留空/未开通/SQLite持久卷”的方案发布。

## 实际配置

- 小程序AppID：`wx676d460774c18c95`；云环境：`yanpeng-d1giw89zv518e3f6e`；服务：`huoji-api`。
- HTTPS就绪地址：`https://huoji-api-yanpeng-d1giw89zv518e3f6e-1374757182.ap-shanghai.run.wxcloudrun.com/readyz`。
- 当前后端版本 `huoji-api-027`、100%流量、MinNum=MaxNum=1、PUBLIC+MINIAPP，2026-10-21 15:51:07更新；最终数据库/存储/认证/模型检查全部通过。桌面默认也走真实云端，只有显式USE_LOCAL_API才直连本机。
- 业务请求通过 `wx.cloud.callContainer`，域名由WorkBuddy托管。不要回到公网wx.request测试来代替小程序容器通道；不要关闭urlCheck。请求JSON显式序列化；下载使用 `dataType:'text', responseType:'arraybuffer'`。
- 云状态在独立huoji_*数据库表/私有huoji路径，容器磁盘为临时盘。保留当前服务端环境变量和加密密钥；不要打印平台detail中的凭据或把其放进仓库。

## 数据库与镜像

已单独应用 `20261018090000_huoji_cloud_tasks.sql`、`20261018091500_huoji_photo_attachment.sql`、`20261018194000_huoji_product_trash.sql`。前者保留核心函数并包装任务/上传操作，后者修复媒体关联别名冲突。不要整目录migration up，历史平台迁移编号和本地不完全相同；不得传 `--role postgres`。

白名单部署包只含Docker/依赖/TS运行源码，不含.env、.data、内部Excel、客户端与文档。Node24云端构建，cloudbase后端，不挂持久卷、不回退SQLite。最新后端包 `/tmp/huoji-pack-20261021-adaptive-layout-v6-final`，42文件、493221字节。027在有界动态宽高和图片真实比例排版上增加异常数值局部缩放与超长备注连续行；有续行的工作表禁用自动筛选，防止备注与商品被排序拆散，普通表仍保留筛选。保存过的公司模板宽度、日期范围/商户合并、回收、模板动态字段、混合币种及后台AI能力继续保留。

## 发布前验证

```sh
npm run typecheck
node --import tsx --test --test-force-exit --test-timeout=30000 tests/*.test.ts
node --test --test-timeout=15000 tests/*.test.cjs
npm run build
npm run check:release
npm run test:api
```

2026-10-21最终229项TS/253项CJS均通过，typecheck、生产build、check:release和test:api通过。027公开readyz四项通过；开发者工具实际`wx.cloud.callContainer`新建异步导出并下载153588字节文件，10商家/38行/44图/12行分币种TOTAL及逐格值、公式、图片边界、CRC通过，SHA256为`1fd7c501aed7e6f15b1f6ac01dc0273810be8cfaf8e5888b9d7b91d8072816f3`，与026文件不同。该文件只有一个下载chunk，未验证4MiB多段或弱网大文件。文件验收不能只看PK头或openDocument成功。

## 本次预览结果

2026-10-21最新工作区预览二维码为 `docs/demo/huoji-preview-20261021-adaptive-v6-final.jpg`，入口`pages/login/index`，预览包460962字节。此二维码包含商户优先录入和最终商品页代码；本轮没有执行upload，因此不能声称公众平台已有新的上传版本或已选择体验版。二维码有时效，手机相机、软键盘、弱网与分享仍需扫码实测。

## 历史上传结果

1.2.1代码包已由微信开发者工具upload上传成功，314,440字节，描述“十页体验改版；草稿与AI修复；带图Excel下载；采购提示随数据更新”。日志 `/tmp/huoji-upload-121-20261018.log`。

预览二维码 `docs/demo/huoji-preview-121-20261018.png` 已生成，470×470。预览是有时效的开发包；本次没有微信后台将1.2.1设置为体验版的独立证据，不能声称后台已切换。需要长期体验入口时，在微信公众平台开发管理核对并选择本次上传版本。

复用用户skill的upload/create_preview_qrcode流程，新发版换版本和二维码文件名。操作指引位于 `/Users/yanpeng/.tcodex/skills/wechat-miniprogram-ops/SKILL.md`。

## 运行边界

任务/结果持久化，执行仍在进程内；重启失去执行者后5分钟超时，需重提。照片分片暂存在内存，保持单实例。文件4MiB分段、80MB上限，当前真实验证为小文件；无大文件真机/弱网压测。首版隐藏上传表格入口，历史接口不代表小程序大表直传可用。手机拍照、键盘、真实文件分享及两个真实微信账号验证尚未完成。

2026-10-18 16:30（北京时间）：用户反馈预览失效，重新上传同版1.2.1成功并生成新二维码 `docs/demo/huoji-preview-121-20261018-163011.png`。类型检查、164项TS、113项CJS、build、check:release通过；未改业务代码或数据。


2026-10-18 17:00后：AI授权恢复修复发布完成，后端huoji-api-016、100%流量、MinNum=MaxNum=1、PUBLIC+MINIAPP；readyz四项通过。数据库单独应用20261018164500_huoji_model_session_cas.sql，CAS与deadline guard云端确认存在。169项TS、116项CJS、typecheck/build/check:release/API通过。

前端1.2.2上传成功316368字节，新预览二维码 `docs/demo/huoji-preview-122-20261018-modelauth.png`。仅更新后端的颜色兼容不会改变该前端包。后台是否已把1.2.2选为体验版仍无独立证据，不能把upload成功当成已切换后台选择。

开发者工具真实云端复测：电脑当前模型会话设为过期且无效refresh后，页面第一次任务MODEL_LOGIN_REQUIRED → wx.login恢复接口200/restored → 一次重提 → 任务succeeded，自动填入陶瓷杯/白色/12元/MOQ100；输入保留。全程没有新业务登录或替换账号。记录 `docs/demo/ai-model-session-recovery-20261018.json`。手机用户需扫新预览复测；未声称手机已验收。


2026-10-18 18:40 UX发布：后端017已上线100%，PUBLIC+MINIAPP与单实例配置保持。头像标准化POST经小程序真实云端通道返回200/455字符JPEG，未保存或修改用户资料。171项TS/120项CJS、typecheck/build/check:release/API通过，含头像校验/按账号资料保存、真实采购及报价Excel颜色。最新日志 `/tmp/huoji-ux-{ts-final,cjs-release3,typecheck-final,build-final,api-final}.log`。

前端1.2.3上传成功350892字节，日志 `/tmp/huoji-upload-123-20261018-ux.log`，新预览 `docs/demo/huoji-preview-123-20261018-ux.png`。没有后台选择体验版本的证据。开发者工具实际检查商品/我的/个人资料/设置，字号11.5pt与选色改变预览；测试公司设置恢复原值。原生头像选择器、手机键盘和手势触感仍需手机复测。


## 2026-10-18 19:30 · 1.2.4录入与后台整理

前端1.2.4已上传367742字节，二维码在 `docs/demo/huoji-preview-124-20261018-capture.png`。177项TS、124项CJS、typecheck/build/check:release/HTTP冒烟通过，后端018部署成功且就绪与单实例配置确认。后台商品整理复用已有数据库extraction任务；每账号串行、最多4条待处理，全局12条。受理前原始商品已保存，提交或模型失败保留原数据；任务号和版本共同保护写回。

CloudJobs执行权仍在进程内，持久任务不代表可恢复执行队列。重启后5分钟超时后重试；扩容前必须迁移照片分片暂存。商品页自动刷新状态，MODEL_LOGIN_REQUIRED失败时当前微信身份恢复一次并重试同件，其他失败展示提示；未真机压测大量照片与大文件。导出上限500件/累计嵌图40MB/下载80MB。

实际云端图文记录保存并继续、后台字段写回、列表缩略图、4件商品带图Excel生成下载打开及本地解析通过。相机测试素材是合成JPEG，picker注入不能替代真机相册授权测试。


## 2026-10-18 20:30 · 1.2.6日期、动态表格与回收站

前端1.2.6上传成功415241字节，日志 /tmp/huoji-upload-126-20261018.log，新预览二维码 docs/demo/huoji-preview-126-20261018-final.png。125是复查前中间包，以126为准。上传不代表微信公众平台已选择体验版本，二维码为有时效的开发预览。

后端huoji-api-020已部署，正常版本、单实例PUBLIC+MINIAPP，readyz四项通过。独立回收站迁移已落云端；真实容器通道验证移入/恢复、原任务和首次保存日期/照片/custom保留，云端带图导出成功并下载打开后完整解析（83499字节、6sheet、3图片）。

最终188TS、181CJS、typecheck/build/check:release/HTTP冒烟均通过。独立子agent复核实际日期/录入/我的/回收站/悬浮新建截图；反馈的混合币种标签、模板临时hide、窄屏同排、回收恢复本机修改和公司精度预览均已修复并有回归。

默认按参考11列顺序与表头导出，按商户sheet。表格设置启用/改名/扩展字段映射录入页，纯字体字号变化不改变录入字段；未启用的旧扩展值保留。回收站单件操作为卡片右下两个小图标，批量操作仍统一操作栏，永久删除必须确认。我的一卡含收藏/回收站/草稿箱/表格设置/常用币种/使用帮助，帮助最后；看货新增右下悬浮+，打开表单回顶部、×收起。

正式任务现在5件合成商品；另有一件清楚标记的合成商品留在回收站供用户演示，不计入导出和数量。真实资料/模板/采购Excel未覆盖或上传。真机相机、软键盘/触感、320px手机画面与好友文件分享未验证，未发送文件给任何好友。

最终独立复核：P1/P2均关闭，9项定向测试通过，无剩余阻塞。1.2.6上传及新码生成均已读回success；第一次二维码生成失败后顺序重试成功。回收站另保留1件合成展示商品（05630596-41d6-4291-bc82-7cd5fe6aac2e），活动任务仍5件。

## 2026-10-18 · 1.2.7商户看货

看货入口按记录日期和商户聚合，旧任务作为内部存储关联继续保留，页面显示商户。相同名称商户跨旧任务合并展示和日期范围查询；首次新建可记录联系方式，连续新增继承店名与联系方式。右下悬浮+打开居中小卡片。日期顶部删除全部/今天入口。历史页新增切到今天后再打开表单。

后端huoji-api-021已云端生效，100%流量、MinNum=MaxNum=1、PUBLIC+MINIAPP，readyz四项通过。两项独立迁移已幂等应用：20261018211500_huoji_merchant_scope.sql和20261018214500_huoji_merchant_visits.sql；不得重跑早期基础任务迁移覆盖当前SQL包装。supplier为精确筛选：未传为全部，空字符串为未填写商户；分页游标、统计、导出任务范围一致。商户列表SQL聚合，不依靠前30件推断商户。

开发者工具真实云端验证：商户看货聚合成功；后台演示商户连续记录第二件合成商品，保存继续后商品字段清空、店名与联系人保留。单商户选定2026-10-18导出2件，实际文件后台演示商户-2026-10-18.xlsx已下载并打开，31280字节；本地解析同商户2行、1张图片、参考11列和多行字号。当天汇总名看货记录-YYYY-MM-DD.xlsx，每商户独立sheet，回收站与草稿排除；单商户文件亦带记录日期，实际下载路径保留文件名。

最终205项TS、199项CJS、typecheck/build/check:release通过；PG26项迁移/兼容回归此前通过。子agent已复核四项商户状态修复和真实modal/双列商品截图，后续显式day导航清商户筛选、中文跳转解码及实际文件名追加回归。真机键盘/相册权限/好友分享尚未实测。

合成演示项目新增1件“同店演示 · 玻璃储物罐”；实际采购、个人资料和公司模板未改。原回收站演示保留。原数据导出字体与公司设置保持，空公司信息不虚填。Artifact工具渲染把空文本显示0，本次仅做只读检查，实际ExcelJS解析为空字符串，原文件不受影响。

1.2.7已上传成功，442171字节，日志/tmp/huoji-upload-127-20261018.log。最终子agent复核空白新品21:39截图、显式day优先清未消费商户选择，4项定向回归通过，无剩余P1/P2。新预览二维码已成功生成：docs/demo/huoji-preview-127-20261018-merchants.png（470×470 PNG）。upload成功不代表微信公众平台已将1.2.7选为体验版。

## 2026-10-21 · 刷新手机预览入口

用户要求生成二维码查看当前效果。使用 `create_preview_qrcode` 直接生成成功，无需重新upload；当前本地代码预览包425635字节，入口 `pages/login/index`。新文件 `docs/demo/huoji-preview-127-20261021-fresh.jpg`，470×470 JPEG，已读回检查。未改业务代码、后端或数据，未选择公众平台体验版本；此为有时效的开发预览，手机扫码与实际效果待用户验证。本日205TS/199CJS及typecheck/build/check:release/隔离HTTP冒烟通过，具体核查见HANDOFF开头。

## 2026-10-21 · 商户入口限制后的新预览

用户要求新品从商户入口记录。商品页无明确商户时改为选择入口，新品携一次性会话/project商户上下文并锁店，空店旧草稿可补全后保存，空店旧商品保存继续回选商户。没有后端或数据库改动，也未执行upload；公众平台已上传版本仍以原1.2.7历史记录为准。

205TS、208CJS、typecheck/build/check:release/隔离HTTP冒烟及改动WXML/WXSS原生编译通过；独立子agent复核代码与真实开发者工具截图无阻塞。实际只读点击验证入口与锁店，未保存或覆盖真实业务数据，手机验证尚待用户进行。

`create_preview_qrcode` 直接生成本轮代码预览，工具报告success，包445171字节；新码 `docs/demo/huoji-preview-20261021-merchant-entry.jpg`（470×470 JPEG，已读回）。该码替代本日较早fresh码用于看本轮效果，有时效，不表示公众平台体验版本已更新。


## 2026-10-21 · 参考Excel回放与交叉复核（仅本地）

最终211TS、217CJS、typecheck/build/check:release/隔离HTTP冒烟通过；editor/export/procurement WXML原生编译success。多图导出、采购字段保留/实际数量、新旧数量API兼容、商户导出核对范围、回执日期和草稿提醒已修复，原生开发者工具截图经独立agent复核。Excel实际打开并重算核验；窄币种价格####及筛选表头遮挡已修复。

同数据本地回放保留10商家、38记录44图，日常已核对选品文件33条37图（商品68944.80），完整采购文件保留原页并追加4视图（38条44图，原参考金额69454.80，8家未知运费使新总计留空）。3份受保护原文件hash不变。原Excel及产物仅放忽略的.data目录，未上传云端/Git。详细输入、人工复现的采购决策/运费、文件路径和限制见HANDOFF最新段。

本段未部署后端、未迁移、未重新upload或改体验版本；实际服务仍021。新客户端遇旧采购API会隐藏实际数量编辑并省略quantity，旧接口可继续保存。先前预览码不代表后端导出修复已发布。本轮云端业务链路、完整大文件下载及真机相机/键盘/分享均未验证；测试与本机Excel正确不能替代云端和手机验收。


## 2026-10-21 · 日期范围与商户TOTAL（本地待发布）

用户场景调整为统一商品Excel：单日或含首尾日期范围、全部/单店商户、跨任务同名商户合并sheet、商品保留独立行。新增dateFrom/dateTo贯穿preview/列表/summary/merchant/sync/async job，客户端文件名带完整日期，变化撤销缓存。每商户按币种TOTAL保护未知值和明确0，500件公式参数上限回归通过。

新增迁移20261021090000_huoji_date_range.sql，依赖现有021的merchant/tasks核心包装；仅在/tmp独立PG16应用并验证幂等，未向云端应用。GET /api/capabilities以实际DB能力决定dateRangeExport，新后端遇旧SQL会拒绝范围，前端亦不会静默回落成其他范围。后续上线仅应用此新增迁移，确认云函数支持，再完成后端部署、真实wx.cloud.callContainer的能力/范围异步导出检查和前端发布，禁止重跑早期基础迁移覆盖包装。

221TS、229CJS、typecheck/build/check:release及隔离HTTP冒烟全部通过；export WXML/WXSS原生编译success，真实隔离PG的异步HTTP→job→XLSX通过。新本地同数据样表10商户38商品44图/10TOTAL、约1.4MB，实际Excel重算及独立agent核验通过，详细路径/数值/人工日期分配见HANDOFF最新段。

当前未部署/未upload/未切公众平台体验版本，仍021；实际开发者工具当前云请求显示服务暂不可用，不宣称线上范围导出成功。范围布局为合成内存展示，手机与分享未验。真实采购文件、资料、保存公司模板未改未上传，3保护hash一致。


## 2026-10-21 · 完整验收受云资源隔离阻塞（未发布、未交付）

用户要求完整验证后交付。本轮重新221TS/234CJS、typecheck/build/check:release/隔离HTTP冒烟通过。修复云容器不可用误回公网通道及能力探测切后台busy残留，原生实际导航回归/独立agent复核通过。小程序包数据/密钥白名单检查和后端42文件白名单包通过；包 `/tmp/huoji-pack-20261021-range-delivery` 尚未上传。

真实HTTPS readyz和wx.cloud.callContainer readyz均503 SERVICE_FORBIDDEN/Your server is isolated；cloudrun detail ResourceIsolated，PG只读SQL也报告current Isolated。环境NORMAL且体验版未到期，具体隔离原因尚不能确认；费用中心查询无权限，没有自行充值、续费或扩权。已要求用户控制台恢复云托管/PG资源。未部署、未迁移、未upload、未新建云测试商品；不发无法使用的新二维码，不标交付。

仅新SQL隔离暂存于 `/tmp/huoji-delivery-20261021/migration-only`。资源恢复后先取得函数备份和云端资料/模板保护hash，再用该独立cwd执行migration up dry-run确认只含20261021090000，然后应用；严禁在全历史目录直接up或传--role postgres。云端链路与手机完整验收、公众平台体验版本选择均仍未完成。详细证据和续接顺序见HANDOFF最新段。


## 最新恢复检查 · 2026-10-21 13:45 · 云资源已恢复，完整验收继续

用户反馈恢复状态与日志未更新，本段覆盖下方“云资源隔离阻塞”的当前状态描述，保留历史排障记录。尚未完成本轮真实云端导出与手机验收，不标记交付。

- 重新检查公开 /readyz 返回200，数据库/storage/auth/model均就绪；管理SQL纯SELECT成功。当前云托管已为huoji-api-022，normal、100%流量、Min=Max=1、PUBLIC+MINIAPP，平台更新时间2026-10-21 13:30:01。本轮未执行部署，不将现有022归为本轮发布。
- 下载022源包，对比本地后端白名单42个运行文件，内容全部一致；无需重复部署。独立子agent只读核对远端范围helper函数与本地新SQL一致，core产品/商家/游标/汇总及jobs范围校验/白名单/capabilities均已存在，无需重复迁移。远端migration history未登记20261021090000不代表函数未生效，不repair或伪造本轮执行记录。
- 写入测试前基线：用户1、公司模板0、采购表1、看货任务4、商品8、图片5、后台任务26。四份函数定义及资料/模板哈希已私有备份；本轮截至此检查仅只读，未修改既有业务数据/资料/模板。
- 资源恢复后重新运行221TS、234CJS，全部通过且0跳过；typecheck/build/check:release通过。日志 `/tmp/huoji-delivery-20261021/{ts-restored.log,cjs-restored.log,release-restored.log}`；恢复检查、函数备份/保护基线同目录，均私有，不上传。
- 下一步继续实际wx.cloud.callContainer能力/业务与异步导出验证、合成独立数据范围/同商家合并、实际Excel核验；手机相机/键盘/分享和公众平台体验版选择仍不能据本段推断已通过。



## 最新验收进展 · 2026-10-21 14:00 · 真实云端主链路已通过，商品页复查继续

本段覆盖下方仍描述“云端导出待验”的过程状态；尚未标记完整交付，手机实测与公众平台体验版本选择仍未取得证据。

- 真实wx.login→wx.cloud.callContainer POST /api/auth/wechat 返回200，有有效会话；未覆盖本机正常登录资料。合成文本通过POST /api/extract返回202，任务最终succeeded/mode=model，实际模型提取玻璃储物罐、TEST-AI-20261021、CNY2.5/24件每箱/2箱/48件，未知字段未伪造；并非rules降级或仅readyz。
- 独立TEST owner（两个隔离身份，不改正常用户session）通过实际容器API保存10商家/38商品/44张新生成图，首张66743B跨两个照片分片。所有请求JSON.stringify、14秒以内单次，照片与Excel业务无公网回退。仅本次38件合成ID/owner/project/name/sku/version1严格限定SQL布置18日18件、21日20件；不改变真实商品，不冒充普通用户可回填日期。
- 云端真实日期/商户/分页/已核对验证：range38、10商家、44图；两单日18/20；已核对25；分页30+8；同店同SKU两次保存仍保留2行；默认11核心列。独立peer对商品/照片/项目汇总/任务/任务文件5条路径均404，peer商品数0。
- 五种实际云端异步任务均succeeded，完整容器二进制文件下载后逐行数值/图序像素/TOTAL公式及缓存/币种/0未知/前导零条码/ZIP CRC检查全部通过：范围带图38行44图10店（154142B）；单日带图18行22图10店（119098B）；范围仅核对纯数据25行0图10店（43332B）；单店带图4行8图1店（57392B）；范围内部记录38行0图10店（54988B）。由于混币，范围TOTAL12行，不混加币种。此合成文件与真实参考回放样表分别验证，未上传真实参考表/图片。
- 私有证据 `/tmp/huoji-delivery-20261021/cloud-fixture/`，包括cloud-*.xlsx、cloud-export-validation.json、scopes/isolation和本次ID回执。fixture脚本包含测试短期token，仅私有600，禁止加入仓库或输出源码。正常采购/资料/模板保护基线最终复查仍待执行。
- 用户指出商品页混乱，已修复日期/商户顶部与导出入口重复、比较恢复模式不一致、AI补价后筛选计数不刷新、慢商户汇总被搜索丢弃、同店跨旧任务草稿遗漏；选择比较/管理时暂缓AI刷新保护选择。新增11实际逻辑场景，全量221TS/245CJS及typecheck/build/release重跑通过。原生页面编译、实际交互截图与独立子agent复核继续，尚未发布新前端或新二维码。
