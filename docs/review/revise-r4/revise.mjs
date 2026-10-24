import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if(fs.existsSync(root+'/report/SOLUTION.md')) throw Error('历史v1.2重建入口已停用；正式方案使用final-v13/finalize.mjs，避免覆盖v1.3。');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const write=(f,s)=>fs.writeFileSync(path.join(root,f),s);
const prior=JSON.parse(read('revise-r4/backup/report/design.json'));
const tokens=prior.tokens;
tokens.typography.dates='10月24日 周六；筛选及导出按北京时间首次保存日，修改不改变记录日';
tokens.typography.letterSpacing=0;
tokens.radius.md_rpx=16;
tokens.radius.usage={sm:'标签、输入框',md:'重复商品卡与弹层',pill:'必要的圆形图标热区'};
tokens.color.brand.usage='主按钮和选中态';
tokens.color.ok.usage='资料人工检查已完成';
tokens.color.warn.usage='缺项、离线、保存结果未知';
tokens.color.info.usage='AI待确认、上传中';
tokens.color.neutral.usage='本机草稿';
tokens.color.danger.usage='保存失败、删除';
tokens.statusLabels={
  shapeRules:{data:'文字标签，不能与多选勾混用',record:'编辑页或列表的保存提示'},
  map:[
    {axis:'资料',label:'缺价格',fg:'#8a5a14',bg:'#fdf3e3'},
    {axis:'资料',label:'AI待确认',fg:'#2f5d8a',bg:'#e9f0f7'},
    {axis:'资料',label:'资料已检查',fg:'#1f7a4d',bg:'#e8f3ec'},
    {axis:'保存',label:'本机草稿',fg:'#4a574f',bg:'#eef1ef'},
    {axis:'保存',label:'保存结果待确认',fg:'#8a5a14',bg:'#fdf3e3'},
  ]
};
tokens.touch.rule='交互热区至少88rpx；截图中展示的按钮也遵守44px热区，不以小字标签承担主操作';
delete tokens.touch.shutter_rpx;
tokens.elevation.card='仅重复项目用轻描边；页面分区不套卡片';
tokens.motion.saveFeedback='先明确本机持久保存，再显示上传进度；未有多件队列前不承诺保存即继续';
tokens.motion.undo='删除照片后可撤销；永久删除另行确认，不做采购行取消';
const screen=(id,name,tab,purpose,layout,keyControls,states,sampleData={})=>({id,name,tab,purpose,layout,keyControls,states,sampleData});
const design={
  meta:{
    name:'货记 · 个人商品记录与整理',version:'1.2',date:'2026-10-24',
    basedOn:'用户本轮澄清 + docs/HANDOFF.md 2026-10-21日期范围商品导出决定',
    status:'评审提案，尚未实现；本轮不改业务代码',
    scope:'采购员自己记录、整理、比较各商家的商品数据，输出参考样式Excel',
    excluded:['采购单tab','批次实体','下单流程','计入/取消/后补状态','发送状态','商户确认','客户CRM','客户报价/回选','付款对账','收货核对','团队共享','柜容预算','独立Web工作台'],
    viewport:{widths:[320,375,414],height:812,rpxPerPxAt375:2},
    drawingNotes:['样例商品、店名、价格全部虚构；不展示任何联系方式数字','保留系统相机，不画页内取景器或录音功能','示意图不是运行中的小程序，按钮仅作导航或布局示意','界面使用看货、商品、我的三个tab；整理是商品页的操作而非另一个业务系统'],
    changes:['撤回旧v1.1订单层及旧handoff采购批次建议','以单日/连续日期范围和商户选择导出，不要求选采购决定','资料完整性、人工检查与AI确认分开，缺项允许导出','所有参考商品记录默认包含，不从备注取消推断排除','不再把90箱/70491.60采购假设结果作为商品表验收指标']
  },
  principles:[
    '记录一次，复看补充，直接导出；减少手机到Excel的重复录入',
    '明确当前商户，连续录入不串店；缺少商户时先选店',
    '未知留空，不让AI根据外观猜价格、数量、体积',
    '资料检查不是采购决定；收藏是个人偏好，不代表要买',
    '保留记录日期和历史版本，不自动合并同货号记录',
    '参考Excel只指导字段与版式，不指导扩张业务流程',
    '复用现有个人数据、商户入口和公司模板，不为小功能建完整系统'
  ],
  tabs:[{id:'field',name:'看货',purpose:'现场按日期找商户并记录'},{id:'library',name:'商品',purpose:'跨日期查找、复看、比较和导出'},{id:'me',name:'我的',purpose:'个人资料、收藏、本机草稿与Excel格式'}],
  entities:[
    {name:'商品记录',id:'product.id',fields:['projectId','supplier','recordedDate','version','name','itemNo','photos','unitPrice','currency','MOQ','piecesPerCarton','cartons','recordedQuantity','cartonSize','cartonCbm','barcode','rawDescription','notes','favorite','rating','confirmed'],rules:['复用现有结构，未知数字为null，显式0有效','数量若明确填写含0优先；否则由箱数×每箱数量推导','修改不改变首次保存日；同货号不同日期是独立记录','已核对不等于所有字段齐全，不能自动改成采购决定']},
    {name:'商户到访',id:'project.id（复用）',fields:['supplier','date','contact','booth'],rules:['新品必须有当前商户上下文','首期拆分店名/摊位输入并联想，不强制完整商户CRM迁移','同名合并的已知限制需提示，独立商户ID待实际重名证据再评估']},
    {name:'Excel格式',id:'owner模板（复用）',fields:['companyHeader','columns','styles','footerText'],rules:['保存过的样式不被新默认值覆盖','付款/唛头只作原始表尾文字，不解析成业务模型','本次导出范围和文字不改变商品记录或永久模板']}
  ],
  stateAxes:[
    {name:'保存',owner:'系统',values:['本机草稿','正在保存','保存结果待确认','已保存','重试失败'],rules:['草稿与正式记录不可静默互相覆盖','重试先查幂等回执，不创建重复商品','完成本机持久保存不冒充云端已保存']},
    {name:'资料',owner:'系统缺项提示+人工检查',values:['缺价格','缺每箱数','AI待确认','资料已检查'],rules:['缺项是提示，不阻断记录和商品表导出','AI只补空，人工改动优先','检查按字段来源管理，不轻率删除旧confirmed语义']}
  ],
  screens:[
    screen('field-today','看货 · 今天','field','找到当前商户，继续记录并发现未保存内容',['日期一行','商户到访列表','问题时显示草稿/上传提示','底部选择商户或进店记录'],['选择日期','商户行进商品','相机直达该店录入','恢复草稿'],['空日可新增商户','离线可查看本机草稿，正式新增的离线能力按实现验证','历史日期新录入提示实际保存今天'],{date:'2026-10-24',weekday:'周六',shops:3,products:12}),
    screen('shop-entry','选择商户','field','复用已有店，避免重复输入和串店',['商户搜索','摊位与店名分开','已有结果','新增入口'],['搜索名称/摊位','选中已有商户','新增并进入录入'],['重名要求区分摊位','取消保留原范围','迟到搜索结果不跨页面'],{shop:'示例百货甲',booth:'虚构摊位 A-01'}),
    screen('merchant-profile','商户商品','field','在这家店复看资料、补问和继续拍照',['店名与摊位','日期范围','商品列表','继续记录/导出'],['改商户基础文字','查看该店跨日记录','导出该店'],['空商户可继续记录','旧同名可能合并时提示','不增加交易历史或订单分段'],{shop:'示例百货甲',count:4}),
    screen('field-capture','记录商品','field','少量核心字段现场写下，其余以后补',['当前店名','照片缩略条和系统拍照入口','描述','名称/价格/货号','每箱数/箱规按需展开','保存返回+保存并继续'],['拍照','从相册补图（次要）','文字整理','补规格','保存返回','保存并继续'],['有同id草稿时先恢复选择','上传失败保留所有照片和输入','版本冲突不覆盖','AI结果仅逐字段补空，人工录入优先'],{shop:'示例百货甲',name:'陶瓷杯',unitPrice:6.8,currency:'CNY',piecesPerCarton:48,cartonSize:'50 × 40 × 30 cm',cartonCbm:0.06,cartons:null,recordedQuantity:null,MOQ:null}),
    screen('library-list','商品 · 整理','library','跨日期找货、检查资料和少翻列表',['单日/日期范围与商户','搜索和缺项筛选','紧凑/大图切换','多选是显式临时模式'],['编辑记录','资料整理','选2件比较','导出当前范围','收藏'],['返回保留分页/滚动/筛选','空范围明确','全选已加载还是全部结果明确','搜索不支持带入导出时先明确提示，不静默扩范围'],{dateFrom:'2026-10-19',dateTo:'2026-10-24',merchants:3,products:12}),
    screen('review-queue','整理资料','library','顺序复看照片和字段，减少打开返回',['照片','当前位置','人工字段','AI建议来源','保存并下一件'],['编辑','逐项接受AI','跳过','保存并下一件'],['无AI时仍可人工整理','缺项允许跳过','没有候选值不提供全部采纳','未保存切换提醒'],{index:2,total:5}),
    screen('compare','比较商品','library','比较自己的记录，不增加候选组实体',['两件商品','相同口径价格','每箱数/箱规/MOQ','差异高亮'],['换比较对象','查看商品','返回原列表'],['不同币种不排序更优','口径未知提示','结束比较不残留相机隐藏或选择模式'],{count:2}),
    screen('export-picker','导出 Excel','library','范围清楚，输出参考样式商品表',['单日/日期范围','全部或指定商户','商品表/次要内部记录','带图/纯数据','实际件数和缺项','参考版式预览','生成后打开/分享'],['生成Excel','打开已生成文件','分享文件','Excel格式（次要）'],['缺价格等提醒但允许导出','草稿/回收站排除','筛选变化使旧文件失效','返回后仍保留相同范围的已生成文件','任务生成/下载进度可重试','0件不生成空文件','不兼容日期范围时明确提示'],{dateFrom:'2026-10-19',dateTo:'2026-10-24',merchants:3,products:12,images:'all',scope:'all',audience:'商品表',missingPrice:1})
  ],
  tokens,
  components:[{name:'商品行',rules:['名称、价格、货号与缺项可读','行内收藏不与多选勾混用','仅重复条目用轻分隔或小圆角']},{name:'保存栏',rules:['有文字和主次，键盘时可见需真机确认','只有成功持久化才能清空输入']},{name:'日期范围',rules:['含首尾、北京时间首次保存日','列表预览/导出/文件名同一条件']},{name:'Excel预览',rules:['是样式示意，不宣称静态HTML等于真实Excel','真实验收查看xlsx公式、图片与桌面Excel打开']}],
  glossary:[
    {term:'商品表',meaning:'各商家选购或记录的商品Excel，不表示已下单'},
    {term:'整理资料',meaning:'采购员自己复看、补全和确认字段，不是审批'},
    {term:'已核对',meaning:'现有资料人工检查标记，不代表采购决定'},
    {term:'到访',meaning:'某日某商户的记录容器，复用project'},
    {term:'取消备注',meaning:'原始记录文字，不自动删行或排除导出'}
  ]
};
write('report/design.json',JSON.stringify(design,null,2)+'\n');
// Preserve all issue identifiers with evidence, but retire unsupported business-system conclusions.
const old=read('revise-r4/backup/report/REPORT.md');
const appendix=old.slice(old.indexOf('## 附录 A 问题总表'),old.indexOf('## 附录 B 截图与示意图索引'));
const overrides={
  E1:['撤回“订单层缺失”：主线为日期/商户/商品，不加采购单','范围纠正','不排期','用户本轮明确；docs/HANDOFF.md 2026-10-21商品导出决定'],
  E2:['商品表与采购假设口径不同，不把取消/后补/运费自动解释为业务决定','范围纠正','不作计算Bug','样本记录全部导出为96箱/79260；采购假设90箱不是本期目标'],
  E3:['表尾原文导出前不可见，易误用模板','体验','P2','只改善模板可见性，不建客户/批次规则'],
  E7:['资料检查含义与撤销规则不清','资料','P1','保留人工核对语义，明确缺项与AI建议，不增加采购状态'],
  E8:['不新增选品决定状态；收藏/评分/评价是个人偏好','范围纠正','不排期','product-page.js:233-261；旧发现不意味着缺少入选/淘汰'],
  E11:['隐藏采购整理页不接入主流程','历史功能','不排期','复用商品记录与导出；不恢复下单入口'],
  E12:['帮助页部分入口说明过时，隐藏页仅保留历史兼容','体验','P2','help/index.wxml:1；不按旧S2恢复采购入口'],
  E14:['回收站删除应与日常收藏偏好分开','数据','P2','未收藏不应推断为不要或需删除'],
  E17:['团队共享不在本期范围','范围外','不排期','用户个人记录整理；不为未来共享预加space_id'],
  E19:['客户视图/隐藏底价不在本期范围','范围外','不排期','商品表按实际记录导出，不预设客户报价'],
  X21:['客户当场决定与下单路径不在本期范围','范围外','不排期','数量仅作已知表格数据，未知留空'],
  X12:['两件比较保留；改善范围选择、差异高亮和结束后状态','体验','P2','store.js:17-23；product-page.js:64,277；compare/index.wxml:16；不建候选组/决策'],
  X14:['商品Excel排版已有历史验收；继续查公式、图片、范围，不加运费或下单结构','Excel','P2/回归检查','docs/HANDOFF.md 2026-10-21 16:03；quotation-export.ts；不能沿用全部静态值旧结论'],
  X15:['嵌图尺寸/文件大小需实测；同范围返回保留文件','体验/规模','P1','quotation-export.ts:346-409；export/index.js:38,44；约140张上限为历史模拟，不是固定容量'],
  X19:['会话到期需保留草稿和返回上下文，离线可读本机内容','体验','P2','src/server/cloud-auth.ts:35；utils/auth-gate.js；7天到期是机制，不证明每周固定使用表现'],
  PF12:['单实例队列和全局并发限制是规模风险，实际规模后评估','平台','P2/待规模验证','app.ts:197-201,248,377,403,564；不引入团队共享'],
  PF13:['接口变化要兼容旧客户端；不能依赖强制更新','平台','P2','utils/store.js:88；版本协商和旧小文件回归'],
  R1:['公开代理业务不意味着本产品需客户/订单实体','行业背景','不排期','用户范围优先于其他公司的流程'],
  R2:['默认商品表，次要内部记录；不引入三类业务单据','范围纠正','P2','范围、图片、字段与参考样式为核心'],
  R4:['柜容/装柜预算不在本期范围','范围外','不排期','体积作为商品资料即可'],
  R6:['客户回选闭环不在本期范围','范围外','不排期','不建回选导入或客户勾选链接'],
  R7:['不新建Web整理台或多维表格同步','范围外','不排期','先做好手机复看和Excel'],
  R3:['现场耗时与单手操作待跟岗；不开发录音系统','外部','P2/待验证','历史外国买家指南不等于采购员实际节奏'],
  R8:['先拍后整理的需求待验证；只作照片与字段的局部增强','外部','P2/待验证','真实照片结构观察，不承诺连拍系统'],
  R9:['照片旋转/排序可评估；不建凭证或样品管理系统','外部','P3/待验证','旧证据只作参考，当前用户范围优先'],
};
const rows=appendix.split('\n').filter(l=>/^\| (?:E|B|X|PF|V|R)\d+ \|/.test(l)).map(l=>{
  const cols=l.split('|').map(x=>x.trim());const id=cols[1];
  if(overrides[id]) return `| ${id} | ${overrides[id][0]} | ${overrides[id][1]} | ${overrides[id][2]} | 本轮已重新归类 | ${overrides[id][3]} |`;
  l=l.replaceAll('客户表','商品表').replaceAll('客户版','商品表').replaceAll('客户表格','商品表')
    .replaceAll('客户表','商品表').replaceAll('客户','使用者').replaceAll('订单层上线前它是按使用者打包的唯一办法','范围导出与所选导出的边界需明确')
    .replaceAll('淘汰','偏好标记').replaceAll('订单','历史参考表').replaceAll('真实应为','采购假设口径');
  return l;
});
write('revise-r4/issue-register.md','# 历史问题ID追溯（已按个人记录范围重新归类）\n\n不排期的条目不是待开发需求。未明确重审的条目中“已核实”来自旧评审，不表示本轮重新复现；以当前REPORT.md的范围与验证边界为准。旧数值、阶段编号和报告小节引用只用于追溯备份稿，不是当前排期。\n\n| ID | 当前解释 | 类别 | 优先级 | 核实状态 | 证据 |\n|---|---|---|---|---|---|\n'+rows.join('\n')+'\n');
// Every research claim receives an explicit disposition; re-fetching a domain is not whole-claim verification.
const sets=[
  ['marks',JSON.parse(read('mark-convention/result.json')).claims],
  ['pain',JSON.parse(read('buyer-pain/pain-points.json')).claims],
  ['format',JSON.parse(read('po-format/findings.json')).claims],
  ['earlier-audit',JSON.parse(read('research-audit/out/audit_claims_v2.json')).claims]
];
const journal=fs.readFileSync('/root/.tclaude/projects/-data-workspace-hanpengyan/653b92c1-1e1c-4de8-9343-f5c3397a2d8c/subagents/workflows/wf_5eb88580-486/journal.jsonl','utf8').trim().split('\n').map(JSON.parse);
for(const [agent,name] of [['ab6de5fa2585e4b96','workflow'],['ae41e5c860d07b585','english']]){
  const record=journal.find(x=>x.type==='result'&&x.agentId===agent);
  if(!record?.result?.claims) throw Error('missing '+name);
  sets.push([name,record.result.claims]);
}
const explicit={
  M01:['限定公司实例','不能全行业同义；用户无须编号体系'],
  M02:['限定公司实例','唯一唛头为公司规则，不成为商品导出条件'],
  M03:['行业背景','多行规则可异；模板文字不建工作流'],
  M05:['待确认推断','样本元数据不能证明稳定身份或复制动作'],
  M08:['撤回推断','不能从文件名和最后保存路径断言同时服务两个客户'],
  M14:['撤回推断','体积不能确认运输方式；不做柜容预算'],
  M18:['撤回产品建议','代号不是本期产品主键，不建批次实体'],
  M20:['待确认推断','批次、日期、复制动作均不能从元数据确定'],
  M21:['待确认推断','文件日期含义未知；记录使用实际首次保存日'],
  M25:['限定标识类型','商品码来源不能统一归买方；本期可选字符串'],
  M26:['限定标识类型','同款不同记录允许同码；不做普遍唯一性规则'],
  M27:['保留局部问题','改善导出表尾可见性，不建批次模型'],
  C07:['待确认推断','模板复用线索不证明实际复制动作'],
  C18:['撤回排序','没有可比较样本频率，不声称五大痛点顺序'],
  C19:['撤回产品建议','采购员所在仓库及协作未知，产品不是到货预报'],
  F03:['行业背景','单据定义不决定本产品业务'],
  F05:['待确认推断','PI标题不足以确定模板来源'],
  F08:['限定历史实例','历史账期文章不能说明今日普遍惯例'],
  F09:['行业背景','课件有两类支付方式，不能解释样本30'],
  F10:['撤回倾向判断','保留原文；不能偏向30天或30%'],
  F15:['限定标识类型','一码不同商品才值得核查，同款复看可同码'],
  F17:['保留样本文字/撤回通用规则','不照样本强制69开头13位，不自动生成'],
  F18:['未完成法律核验','本期不生成零售码；不引用最新法条作法律结论'],
  F22:['保留局部问题','参考式表尾和模板可见性，不自动构建订货单'],
  N06:['撤回倾向判断','与F10方向相反，两个推断都不采用'],
};
const currentURLs=new Set(['https://www.yptclogistics.com/article.php?id=57','https://angkatph.com/blog/shipping-from-yiwu-to-philippines.html','https://cn.yiwusell.com/11671.html','http://www.djcargo.cn/what-is-the-shipping-mark','https://www.djcargo.cn/what-is-the-shipping-mark','https://qjwb.tidenews.com.cn/html/2010-09/20/content_542999.htm','https://www.gs1.org/standards/id-keys/gtin','https://www.gs1.org/services/check-digit-calculator']);
const audit=sets.flatMap(([group,claims])=>claims.map(c=>{
  const [disposition,reason]=explicit[c.id]||['历史证据未逐条独立复核','不直接采用原置信度；仅用与个人记录/整理/Excel相符的局部材料，不由行业流程新增业务'];
  return {group,id:c.id,disposition,reason,originalInference:!!c.inference,
    sourceChecks:(c.evidence||[]).map(e=>{
      const u=e.url||'';
      return {status:currentURLs.has(u)?'本轮取得原网页；不等于整条泛化结论核实':u.startsWith('file:')?'本机历史证据；范围解释已重审':u.includes('P020191115604196280605')?'官方PDF历史存档+本轮搜索重新命中':u.includes('ywsst.net')?'本轮原网页空正文，未核实':'历史存档或搜索摘要，本轮未独立复核'};
    })
  };
}));
write('revise-r4/claim-audit.json',JSON.stringify({date:'2026-10-24',scope:'个人商品记录与整理，不做下单',count:audit.length,groups:sets.map(([name,c])=>({name,count:c.length})),claims:audit},null,2)+'\n');
const pages=JSON.parse(read('revise-r4/evidence/pages.json'));
for(const p of pages) if(p.id==='shangxiang'){p.status='empty-body';p.note='只有空标题，不构成核实';}
write('revise-r4/evidence/pages.json',JSON.stringify(pages,null,2)+'\n');
write('report/REPORT.md',read('revise-r4/REPORT-current.md'));
console.log(JSON.stringify({version:design.meta.version,screens:design.screens.length,issues:rows.length,audited:audit.length,appChanged:false}));
