import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(root + '/' + file, 'utf8');
const write = (file, value) => fs.writeFileSync(root + '/' + file, value);
const baseline = root + '/final-v13/baseline-v12';
if (!fs.existsSync(baseline)) {
  const files = ['report/REPORT.md','report/design.json','HANDOFF-REVIEW.md','HANDOFF-TODO.md'];
  for (const file of files) {
    const target = baseline + '/' + file;
    fs.mkdirSync(target.slice(0,target.lastIndexOf('/')), {recursive:true});
    fs.copyFileSync(root + '/' + file,target);
  }
}
const design = JSON.parse(read('report/design.json'));
design.meta.version = '1.3';
design.meta.status = '四批本地实现与回归完成；桌面/真实容器/微信真机待验；不含部署授权';
design.meta.basedOn = '用户个人商品记录场景 + 本机参考Excel结构 + 9d07bc2代码复核；以SOLUTION.md为准';
design.meta.authority = 'SOLUTION.md';
design.meta.drawingNotes = [...new Set([...design.meta.drawingNotes.filter(note=>!note.includes('三个tab')),'商户/商品两个tab；右上角进入普通设置页；辅助页面不画tabBar','八张图是现有页面/弹层/范围的状态，不新增八条路由；补充资料复用编辑页'])];
design.meta.changes = [
  '最终商户/商品两tab、右上角设置；四批本地实现；不建立下单/批次/客户/团队业务',
  '使用实际ProductFields，不以概念伪字段作为数据库字段',
  '取消独立整理队列及逐字段AI来源系统，复用编辑页人工补充',
  '首期导出日期/商户/all或confirmed，不实现q/status/ids导出',
  '参考带图商品表十一列；派生公式+缓存已实现，实际合成xlsx验证',
  '容器v2二进制640KiB分段；保护缓存60MiB/导出7天，需真机验收'
];
design.meta.deferred = ['独立整理队列', '逐字段AI来源模型', '搜索结果/所选导出', '独立商户档案', '自动合并', '照片裁剪旋转', '多件离线上传队列'];
design.tabs = [
  {id:'field',name:'商户',purpose:'现场按日期找商户并记录',implementation:'pages/projects/index'},
  {id:'library',name:'商品',purpose:'查找、复看、比较和导出',implementation:'pages/products/index'}
];
design.auxiliaryPages = [{id:'settings',name:'设置',implementation:'pages/me/index',entry:'商户/商品页内容右上角',tab:false,purpose:'个人资料、收藏、草稿、回收站、币种、Excel格式与帮助'}];
design.entities = [
  {
    name:'商品记录', id:'Product.id', source:'forfree/src/lib/types.ts',
    fields:['id','projectId','version','name','sku','supplier','supplierContact','colors','material','dimensions','weightG','unitPrice','currency','moq','cartonQty','cartons','quantity','barcode','exportRemarks','custom','cartonDimensions','cartonCbm','leadTimeDays','tradeTerms','description','notes','confirmed','favorite','rating','evaluation','photos','createdAt','updatedAt','deletedAt','organizeState','organizeJobId','organizeError'],
    computed:['recordDate（createdAt北京时间日期，非存储字段）','derivedQuantity','amount','cbm','missingFlags'],
    rules:['不新增商品字段，数值null未知；cartonQty已知为正整数','quantity显式值含0优先；否则cartons×cartonQty','修改不变createdAt；同货号不同记录不合并','confirmed是资料人工检查，不是购买决定']
  },
  {
    name:'商户到访容器（复用Project）', id:'Project.id', source:'forfree/src/lib/types.ts',
    fields:['id','name','supplier','supplierContact','market','date','demo','createdAt'],
    rules:['复用现有Project，不新增商户ID/booth/contact表','名字或摊位仍为supplier文字，market保留市场/位置含义','跨日sheet按精确supplier分组；旧重名不自动改写']
  },
  {
    name:'Excel格式（现有模板）', id:'owner模板与version', source:'forfree/src/lib/procurement-template.ts',
    fields:['version','company','companyEnglish','address','contact','paymentTerms','shippingMark','packingRequirements','documentTitle','layout','columns','customFields'],
    rules:['新默认商品资料表/PRODUCT RECORD，已保存模板不覆盖','带图默认A:K十一列；无图仅省图片列','模板原文只预览与导出，不解析付款或唛头流程']
  }
];
design.stateAxes = [
  {name:'保存',owner:'系统',values:['本机草稿','正在保存','保存结果待确认','已保存','重试失败'],rules:['有稿默认恢复，查看云版本只读','本次快照成功才清相应草稿，受引用照片保护','云端确认才继续新品，幂等先查回执']},
  {name:'资料',owner:'系统缺项+人工confirmed',values:['缺价格','待核对','资料已核对','整理中','已整理，待核对','整理失败'],rules:['缺项不拦保存/导出，核对不是完整度','不新建逐字段AI来源或AI筛选','AI只补空，不自动换商户/币种；固定事实字段变动撤销confirmed']}
];
const screen = id => design.screens.find(value => value.id === id);
screen('field-today').implementation = 'pages/projects/index';
screen('field-today').name = '商户 · 今天';
screen('shop-entry').implementation = 'pages/projects/index创建弹层，不新增路由';
screen('shop-entry').layout = ['现有商户选择','商户名称 / 摊位标识一个输入','市场/位置与联系方式选填','新增并进入记录'];
screen('shop-entry').keyControls = ['复用已有商户','新增商户','取消返回'];
screen('shop-entry').states = ['新品有明确当前商户','重名以可识别文字区分，不自动迁移旧数据','先不做全历史联想搜索'];
screen('merchant-profile').implementation = 'pages/products/index商户范围';
screen('merchant-profile').keyControls = ['查看该商户日期范围','继续记录','导出该店'];
screen('field-capture').implementation = 'pages/editor/index新品状态';
screen('field-capture').layout = ['当前商户','照片/系统相机','现场描述和整理','名称/单价+币种/货号/颜色','商品说明/表格备注','规格与包装折叠','低频扩展/商户/个人评价折叠','保存返回+保存并继续'];
screen('field-capture').states = ['有商品信息名称可后补，空记录不可存','云端确认成功才继续新品','有同ID草稿默认恢复，查看云版本只读','关键事实变更才撤销核对','AI只补空，商户/币种不自动换'];
screen('field-capture').sampleData = {shop:'示例百货甲',name:'陶瓷杯',sku:'DEMO-A01',unitPrice:6.8,currency:'CNY',cartonQty:48,cartonDimensions:'50 × 40 × 30 cm',cartonCbm:0.06,cartons:null,quantity:null,moq:null};
screen('library-list').implementation = 'pages/products/index日期/日期范围';
screen('library-list').layout = ['单日/日期范围与商户','搜索+all/pending/confirmed/missingPrice','紧凑/大图切换（首次大图）','点商品复用编辑页补资料'];
screen('library-list').keyControls = ['编辑记录补资料','选两件比较','导出Excel（日期/商户范围）','收藏','管理已有记录'];
screen('library-list').states = ['返回保留已加载页/锚点/筛选','搜索和缺项不带入导出，显式说明','选择已加载最多50件用于现有管理，不是所选导出','日期切换清除无关比较选择'];
screen('review-queue').name = '补充资料（编辑页状态）';
screen('review-queue').implementation = 'pages/editor/index已有商品状态，不新增整理队列路由';
screen('review-queue').purpose = '从列表复看、补充当前商品，返回原位置';
screen('review-queue').layout = ['当前商户/已保存记录日','照片','现有人工字段','AI补空结果提示（不伪造逐字段来源）','规格与包装','资料已核对辅助标记'];
screen('review-queue').keyControls = ['补充字段','AI整理（可选）','保存修改','返回保留草稿'];
screen('review-queue').states = ['缺项可保存和导出','不新增候选建议采纳状态','没有保存并下一件整理按钮','编辑后回第40件仍在原位置'];
screen('review-queue').sampleData = {name:'彩色中性笔',sku:'DEMO-B01',cartonQty:null,unitPrice:1.2,currency:'CNY',confirmed:false};
screen('compare').implementation = 'pages/compare/index';
screen('compare').states = ['现有差异筛选回归，不重复重建','不同币种或口径未知不推荐更优','比较结束恢复列表，不残留选择/管理模式'];
screen('export-picker').implementation = 'pages/export/index';
screen('export-picker').layout = ['单日/日期范围','全部或一个商户','全部或仅已核对','带全部图/无图，内部记录次要','实际商品数/商户数/缺项数','十一列参考预览（手机可横向看）','模板原文折叠','生成时间和打开/分享'];
screen('export-picker').states = ['缺项可导出；草稿/回收站排除','搜索/pending/missingPrice不带入文件且显式说明','同范围返回保留生成文件，文件为当时快照','变范围/模板/已知商品修改使旧文件失效','文件丢失/坏块不可冒称成功','0件不生成'];
design.excel = {
  defaultTitle:'商品资料表 / PRODUCT RECORD', defaultScope:'all', defaultAudience:'selection', defaultImages:true,
  optionalDecisionLabel:'资料核对（仅新默认修改，旧模板不覆盖）',
  columns:[
    {key:'sku',field:'sku'},{key:'cartons',field:'cartons'},{key:'pcsPerCarton',field:'cartonQty'},
    {key:'quantity',field:'quantity',derivedFrom:['cartons','cartonQty']},{key:'unitPrice',field:'unitPrice'},
    {key:'amount',computed:'quantity×unitPrice'},{key:'description',composedFrom:['name','colors','material','dimensions','cartonDimensions','exportRemarks']},
    {key:'image',field:'photos'},{key:'cartonCbm',field:'cartonCbm'},{key:'cbm',computed:'cartons×cartonCbm'},{key:'barcode',field:'barcode'}
  ],
  rowFormulas:'派生quantity/amount/cbm写公式+缓存值（已本地实现），显式quantity含0保持数值',
  grouping:'supplier精确文字跨日分sheet，不按sku去重',
  omittedFilters:['q','pending','missingPrice','ids'],
  rules:['记录日取createdAt北京时间，起止含首尾','未知null留空，cartonQty不允许0','不同币种独立TOTAL，不计算换汇','保持保存模板格式和原文，内部个人字段不默认带出','无图只省image，公式按key定位','缺未知的对应完整合计留空']
};
design.confirmation = {
  invalidate:['name','sku','supplier','supplierContact','colors','material','dimensions','weightG','unitPrice','currency','moq','cartonQty','cartons','quantity','barcode','exportRemarks','custom','cartonDimensions','cartonCbm','leadTimeDays','tradeTerms'],
  preserve:['description','notes','evaluation','rating','favorite'],
  photos:'新增/删除撤销；排序/封面不撤销',
  noOp:'实际值不变或AI无事实补空不撤销'
};
design.reliability = {
  transfer:{channel:'callContainer',protocol:2,chunkBytes:655360,responseBudgetBytes:921600,checksum:'sha256',legacy:'默认原协议保持；通过exportFileV2能力协商'},
  cache:{reclaimableBudgetBytes:62914560,exportRetentionDays:7,protected:['draft','pendingUpload','editor','compare','preview','download','open','share']},
  newDatabaseFields:[], noPublicFallback:true
};
design.tokens.statusLabels.map = [
  {axis:'资料',label:'缺价格',fg:'#8a5a14',bg:'#fdf3e3'},
  {axis:'资料',label:'待核对',fg:'#4a574f',bg:'#eef1ef'},
  {axis:'资料',label:'资料已核对',fg:'#1f7a4d',bg:'#e8f3ec'},
  {axis:'资料',label:'已整理，待核对',fg:'#2f5d8a',bg:'#e9f0f7'},
  {axis:'保存',label:'本机草稿',fg:'#4a574f',bg:'#eef1ef'},
  {axis:'保存',label:'保存结果待确认',fg:'#8a5a14',bg:'#fdf3e3'}
];
design.tokens.motion.saveFeedback = '本机持久保存显示草稿；云端成功才清表单继续新品';
design.tokens.color.info.usage = '本次整理提示、上传中，不伪造逐字段来源';
design.tokens.typography.dates = '10月24日 周六；筛选及导出按北京时间首次云端保存日，修改不改变记录日';
design.components = [
  {name:'商品行',rules:['名称/价格/货号清晰，现有大图首次默认，紧凑可记忆','收藏与管理/比较选择互斥','只有视图模型进setData']},
  {name:'保存栏',rules:['新品保存返回/保存并继续有文字主次','编辑已保存商品仅保存修改/返回','云确认才清草稿；键盘可见需真机验收']},
  {name:'日期范围',rules:['含首尾、createdAt北京时间日期','列表与导出共用日期/商户，搜索/缺项不带入需提示']},
  {name:'Excel预览',rules:['实际十一列，手机可横向看；示意五列是局部缩略','显示实际数量/缺项/模板原文','真实xlsx公式/多图/桌面和手机打开为验收']}
];
write('report/design.json', JSON.stringify(design,null,2)+'\n');
for (const [from,to] of [
  ['final-v13/REPORT.md','report/REPORT.md'],
  ['final-v13/HANDOFF-REVIEW.md','HANDOFF-REVIEW.md'],
  ['final-v13/HANDOFF-TODO.md','HANDOFF-TODO.md']
]) write(to,read(from));
// Mirrors let existing handoff/source readers see the same current decisions.
for (const [from,to] of [
  ['report/REPORT.md','revise-r4/REPORT-current.md'],
  ['HANDOFF-REVIEW.md','revise-r4/handoff-review-current.md'],
  ['HANDOFF-TODO.md','revise-r4/handoff-todo-current.md']
]) write(to,read(from));
console.log(JSON.stringify({version:design.meta.version,formalPlan:'report/SOLUTION.md',tabs:design.tabs.length,screens:design.screens.length,newBusinessRoutes:0,implementation:'四批本地实现，未部署/未真机验收'}));
