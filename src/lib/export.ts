import ExcelJS from "exceljs";
import type { Product, Project } from "./types";
import { AppError } from "./errors";
import { chinaDate } from './dates';

export async function exportWorkbook(project: Project, products: Product[], readPhoto: (id: string) => Buffer | null | Promise<Buffer | null>, options: { images?: boolean; scope?: "all" | "confirmed" } = {}) {
  if (products.length > 500) throw new AppError("EXPORT_LIMIT", "单次导出最多500件商品，请拆分看货任务");
  let imageBytes = 0;
  const workbook=new ExcelJS.Workbook();
  workbook.creator="货记"; workbook.created=new Date();
  const sheet=workbook.addWorksheet("看货记录",{views:[{state:"frozen",ySplit:1}]});
  sheet.columns=[
    ...(options.images !== false ? [{header:"商品图片",key:"image",width:18}] : []),
    {header:"商品名称",key:"name",width:22},{header:"货号",key:"sku",width:18},{header:"供应商 / 摊位",key:"supplier",width:24},{header:"供应商联系方式",key:"supplierContact",width:24},
    {header:"颜色",key:"colors",width:20},{header:"材质",key:"material",width:14},{header:"尺寸（含单位）",key:"dimensions",width:22},
    {header:"单件重量(g)",key:"weightG",width:16},{header:"单价",key:"unitPrice",width:12},{header:"币种",key:"currency",width:10},
    {header:"起订量",key:"moq",width:12},{header:"每箱数量",key:"cartonQty",width:14},{header:"照片数量",key:"photoCount",width:12},
    {header:"外箱尺寸（含单位）",key:"cartonDimensions",width:24},{header:"单箱体积(m³)",key:"cartonCbm",width:18},{header:"大货交期(天)",key:"leadTimeDays",width:16},{header:"报价条款",key:"tradeTerms",width:24},
    {header:"确认状态",key:"status",width:12},{header:"收藏",key:"favoriteText",width:10},{header:"选品评分",key:"rating",width:12},{header:"选品评价",key:"evaluation",width:36},{header:"原始描述",key:"description",width:42},{header:"备注",key:"notes",width:30},
    {header:"看货任务",key:"project",width:24},{header:"市场",key:"market",width:20},{header:"任务日期",key:"date",width:14},{header:"记录日期",key:"recordDate",width:14},{header:"示例数据",key:"demo",width:12},
  ];
  sheet.getRow(1).height=28;
  sheet.getRow(1).eachCell(cell=>{cell.font={bold:true,color:{argb:"FFFFFFFF"}};cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF176D5D"}};cell.alignment={vertical:"middle"};});
  for(const product of products) {
    // Strings remain literal cells, including leading '='; never export formulas from user content.
    const row=sheet.addRow({...product,photoCount:product.photos.length,favoriteText:product.favorite?"已收藏":"",status:product.confirmed?"已确认":"待补充",project:product.taskName || project.name,market:product.taskMarket === undefined ? project.market : product.taskMarket,date:product.taskDate || project.date,recordDate:chinaDate(product.createdAt),demo:(product.demo || project.demo)?"模拟数据":""});
    row.height=options.images === false ? 36 : 78;row.alignment={vertical:"middle",wrapText:true};
    if(product.unitPrice!==null) row.getCell("unitPrice").numFmt="0.00";
    if(options.images !== false && product.photos[0]) {
      const photo=await readPhoto(product.photos[0].id);
      imageBytes += photo?.length || 0;
      if (imageBytes > 40 * 1024 * 1024) throw new AppError("EXPORT_LIMIT", "导出图片超过40MB，请拆分看货任务");
      if(photo) { const imageId=workbook.addImage({base64:`data:image/jpeg;base64,${photo.toString("base64")}`,extension:"jpeg"});sheet.addImage(imageId,{tl:{col:0.12,row:row.number-0.9},ext:{width:88,height:88},editAs:"oneCell"}); }
    }
  }
  sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:sheet.columnCount}};
  const info=workbook.addWorksheet("说明");
  info.columns=[{width:24},{width:90}];
  info.addRows([["任务",project.name],["图片",options.images === false ? "本次仅导出文字与数字，不嵌入图片。" : "主表嵌入每件商品首图；全部照片可在货记中查看。"],["未知字段","保持空白，请核对后补充。"],["状态",options.scope === "confirmed" ? "本次仅导出已人工确认的商品。" : "待补充记录也会导出，确认状态单独标注。"],["草稿","本机草稿未正式保存，不纳入导出。"],["报价条款","按用户填写原文导出，不将普通单价自动标为 FOB 或含税价。"],["数据来源",(project.demo || products.some(product => product.demo))?"包含演示商品与参考图片，请勿将演示报价和供应商用于实际采购。":"用户现场采集"],["导出时间",new Date().toISOString()]]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
