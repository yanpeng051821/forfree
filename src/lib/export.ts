import ExcelJS from "exceljs";
import { readPhoto } from "./db";
import type { Product, Project } from "./types";

export async function exportWorkbook(project: Project, products: Product[]) {
  const workbook=new ExcelJS.Workbook();
  workbook.creator="货记"; workbook.created=new Date();
  const sheet=workbook.addWorksheet("看货记录",{views:[{state:"frozen",ySplit:1}]});
  sheet.columns=[
    {header:"商品图片",key:"image",width:18},{header:"商品名称",key:"name",width:22},{header:"供应商",key:"supplier",width:24},
    {header:"颜色",key:"colors",width:20},{header:"材质",key:"material",width:14},{header:"尺寸（含单位）",key:"dimensions",width:22},
    {header:"单件重量(g)",key:"weightG",width:16},{header:"单价",key:"unitPrice",width:12},{header:"币种",key:"currency",width:10},
    {header:"起订量",key:"moq",width:12},{header:"每箱数量",key:"cartonQty",width:14},{header:"照片数量",key:"photoCount",width:12},
    {header:"确认状态",key:"status",width:12},{header:"原始描述",key:"description",width:42},{header:"备注",key:"notes",width:30},
    {header:"看货任务",key:"project",width:24},{header:"市场",key:"market",width:20},{header:"日期",key:"date",width:14},{header:"示例数据",key:"demo",width:12},
  ];
  sheet.getRow(1).height=28;
  sheet.getRow(1).eachCell(cell=>{cell.font={bold:true,color:{argb:"FFFFFFFF"}};cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF176D5D"}};cell.alignment={vertical:"middle"};});
  for(const product of products) {
    // Strings remain literal cells, including leading '='; never export formulas from user content.
    const row=sheet.addRow({...product,photoCount:product.photos.length,status:product.confirmed?"已确认":"待补充",project:project.name,market:project.market,date:project.date,demo:project.demo?"模拟数据":""});
    row.height=78;row.alignment={vertical:"middle",wrapText:true};
    if(product.unitPrice!==null) row.getCell("unitPrice").numFmt="0.00";
    if(product.photos[0]) {
      const photo=readPhoto(product.photos[0].id);
      if(photo) { const imageId=workbook.addImage({base64:`data:image/jpeg;base64,${photo.toString("base64")}`,extension:"jpeg"});sheet.addImage(imageId,{tl:{col:0.12,row:row.number-0.9},ext:{width:88,height:88},editAs:"oneCell"}); }
    }
  }
  sheet.autoFilter={from:"A1",to:"S1"};
  const info=workbook.addWorksheet("说明");
  info.columns=[{width:24},{width:90}];
  info.addRows([["任务",project.name],["图片","主表嵌入每件商品首图；全部照片可在货记中查看。"],["未知字段","保持空白，请核对后补充。"],["状态","待补充记录也会导出，确认状态单独标注。"],["数据来源",project.demo?"项目生成的模拟记录与示意插画，不是真实供应商商品。":"用户现场采集"],["导出时间",new Date().toISOString()]]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
