import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import ExcelJS from "exceljs";
import { extractText, extractWithModel } from "../src/lib/extraction";
import { fieldsSchema, projectSchema } from "../src/lib/schema";
import { randomUUID } from "node:crypto";
import { createProject, closeDB, deleteProduct, getProduct, listProducts, stagePhoto, readPhoto, saveProduct } from "../src/lib/db";
import { prepareImage } from "../src/lib/storage";
import { issueSession } from "../src/server/auth";
import { emptyFields } from "../src/lib/types";
import { exportWorkbook } from "../src/lib/export";
import { exportQuotation, quotationExportMetadata } from '../src/lib/quotation-export';
import { defaultProcurementTemplate } from '../src/lib/procurement-template';

const originalDir=process.env.APP_DATA_DIR;
const root=mkdtempSync(join(tmpdir(),"huoji-tests-"));process.env.APP_DATA_DIR=root;
after(()=>{closeDB();rmSync(root,{recursive:true,force:true});if(originalDir===undefined)delete process.env.APP_DATA_DIR;else process.env.APP_DATA_DIR=originalDir;});

test("extracts explicit price, MOQ, unit weight and carton quantity separately",()=>{
  const {fields}=extractText("陶瓷杯，红白两色，12元一个，100个起订，单个300克，每箱24个。");
  assert.equal(fields.name,"陶瓷杯");assert.equal(fields.colors,"红色、白色");assert.equal(fields.unitPrice,12);assert.equal(fields.moq,100);assert.equal(fields.weightG,300);assert.equal(fields.cartonQty,24);assert.equal(fields.material,"陶瓷");assert.equal(fields.dimensions,undefined);
});
test("never turns carton weight or carton quantity into unit weight or MOQ",()=>{
  const {fields}=extractText("整箱重10公斤，每箱24个，价格还没问");
  assert.equal(fields.weightG,undefined);assert.equal(fields.moq,undefined);assert.equal(fields.unitPrice,undefined);assert.equal(fields.cartonQty,24);
});
test("converts explicit unit kilograms and keeps dimensions with units",()=>{
  const {fields}=extractText("单件重量：0.3kg，尺寸：35×40cm，单价：2.50美元，MOQ:200");
  assert.equal(fields.weightG,300);assert.equal(fields.dimensions,"35×40cm");assert.equal(fields.currency,"USD");assert.equal(fields.moq,200);
});
test("rejects negative prices, fractional counts and invalid dates",()=>{
  assert.equal(fieldsSchema.safeParse({...emptyFields,name:"杯",unitPrice:-1}).success,false);
  assert.equal(fieldsSchema.safeParse({...emptyFields,name:"杯",moq:1.5}).success,false);
  assert.equal(projectSchema.safeParse({name:"测试",market:"",date:"2026-02-30"}).success,false);
});
test("validates model output and removes unknown nulls without guessing",async()=>{
  const old=process.env.MODEL_BASE_URL;process.env.MODEL_BASE_URL="https://example.test/v1";
  try {
    const payload={name:"杯",colors:null,material:null,dimensions:null,weightG:null,unitPrice:12,currency:"CNY",moq:100,cartonQty:null};
    const result=await extractWithModel("杯子",[],async()=>Response.json({choices:[{message:{content:JSON.stringify(payload)}}]}));
    assert.deepEqual(result.fields,{name:"杯",unitPrice:12,currency:"CNY",moq:100});
    await assert.rejects(()=>extractWithModel("杯子",[],async()=>Response.json({choices:[{message:{content:'{"name":"杯"}'}}]})),/格式不正确/);
    await assert.rejects(()=>extractWithModel("杯子",[],async()=>new Response("",{status:429})),/429/);
    await assert.rejects(()=>extractWithModel("杯子",[],async()=>Response.json({choices:[{message:{content:"not json"}}]})),/格式不正确/);
  } finally {if(old===undefined)delete process.env.MODEL_BASE_URL;else process.env.MODEL_BASE_URL=old;}
});
test("rejects malformed and spoofed image files",async()=>{
  await assert.rejects(()=>prepareImage(new File(["invalid"],"bad.jpg",{type:"image/jpeg"})),/无法读取/);
  await assert.rejects(()=>prepareImage(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'],"spoof.jpg",{type:"image/jpeg"})),/无法读取/);
});
test("persists owned products and photos, exports literal text, and deletes",async()=>{
  const owner=issueSession("core-owner").user.id;
  const project=createProject(owner,{name:"测试任务",market:"测试市场",date:"2026-10-02"},randomUUID());
  const other=createProject(owner,{name:"另一个任务",market:"",date:"2026-10-02"},randomUUID());
  const source=await sharp({create:{width:80,height:100,channels:3,background:"#00aa88"}}).png().toBuffer();
  const prepared=await prepareImage(new File([new Uint8Array(source)],"cup.png",{type:"image/png"}));
  const photo=stagePhoto(owner,prepared);
  const fields={...emptyFields,name:'=HYPERLINK("bad")',supplier:"商户A",unitPrice:12,moq:100,colors:'白',material:'陶瓷',dimensions:'高15cm',notes:'PRIVATE_NOTE_CORE',description:'PRIVATE_RAW_CORE',supplierContact:'PRIVATE_CONTACT_CORE'};
  const created=saveProduct(owner,{requestKey:randomUUID(),projectId:project.id,fields,photoIds:[photo.id]});
  assert.equal(created.photos.length,1);assert.ok(readPhoto(owner,photo.id));assert.equal(listProducts(owner,other.id).length,0);
  assert.throws(()=>saveProduct(owner,{requestKey:randomUUID(),projectId:other.id,id:created.id,version:1,fields,photoIds:[]}),/不存在/);
  const updated=saveProduct(owner,{requestKey:randomUUID(),projectId:project.id,id:created.id,version:1,fields:{...fields,unitPrice:15,confirmed:true},photoIds:[photo.id]});
  assert.equal(updated.version,2);assert.equal(updated.unitPrice,15);assert.equal(getProduct(owner,created.id).confirmed,true);
  const exported=await exportWorkbook(project,listProducts(owner,project.id),id=>readPhoto(owner,id));
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(exported as unknown as ExcelJS.Buffer);
  const sheet=workbook.getWorksheet("看货记录")!;
  const cell = (header: string) => { const column = sheet.getRow(1).values as (string | undefined)[]; const index = column.indexOf(header); assert.ok(index > 0, header); return sheet.getRow(2).getCell(index).value; };
  assert.equal(sheet.rowCount,2);assert.equal(cell("商品名称"),'=HYPERLINK("bad")');assert.equal(cell("单价"),15);assert.equal(sheet.getImages().length,1);assert.equal(cell("确认状态"),"已确认");
  // The legacy data workbook retains its own contract; the default customer
  // quotation follows the current reference template and withholds private text.
  const template = defaultProcurementTemplate(), options = { scope: 'confirmed' as const, businessFields: [] };
  const quotation = await exportQuotation(project, listProducts(owner, project.id), id => readPhoto(owner, id), template, options);
  const selection = new ExcelJS.Workbook(); await selection.xlsx.load(quotation as unknown as ExcelJS.Buffer);
  const metadata = quotationExportMetadata(template, options), selectedSheet = selection.getWorksheet('商户A')!;
  const header = metadata.headerRows.filter(row => row.enabled).length + 1;
  assert.deepEqual((selectedSheet.getRow(header).values as string[]).slice(1), template.columns.filter(column => column.enabled).map(column => column.label));
  const selectedCell = (key: string) => { const index = metadata.columns.findIndex(column => column.key === key); assert.ok(index >= 0, key); return selectedSheet.getRow(header + 1).getCell(index + 1); };
  assert.equal(selectedCell('description').value, '=HYPERLINK("bad") / 白 / 陶瓷 / 高15cm');
  assert.equal(selectedCell('description').formula, undefined); assert.equal(selectedCell('unitPrice').value, 15);
  assert.equal(selectedCell('quantity').value, null); assert.equal(selectedCell('amount').value, null);
  assert.equal(selectedSheet.getImages().length, 1); assert.equal(metadata.columns.some(column => column.businessField), false);
  let text = ''; selection.eachSheet(s => s.eachRow(row => row.eachCell(c => { text += c.text; if(c.formula) assert.match(c.formula, /^IF\(COUNT\([A-Z][0-9]+(?::[A-Z][0-9]+)?(?:,[A-Z][0-9]+(?::[A-Z][0-9]+)?)*\)=[0-9]+,SUM\([A-Z][0-9]+(?::[A-Z][0-9]+)?(?:,[A-Z][0-9]+(?::[A-Z][0-9]+)?)*\),""\)$/); })));
  for (const secret of [fields.notes, fields.description, fields.supplierContact]) assert.equal(text.includes(secret), false, secret);
  const explicitOptions = { images: false, audience: 'internal' as const, businessFields: ['name', 'moq', 'notes'] as const };
  const explicit = new ExcelJS.Workbook();
  await explicit.xlsx.load(await exportQuotation(project, [updated], id => readPhoto(owner, id), template, { ...explicitOptions, businessFields: [...explicitOptions.businessFields] }) as unknown as ExcelJS.Buffer);
  const explicitMetadata = quotationExportMetadata(template, { ...explicitOptions, businessFields: [...explicitOptions.businessFields] });
  assert.deepEqual(explicitMetadata.columns.filter(column => column.businessField).map(column => column.businessField), ['name', 'moq', 'notes']);
  const explicitSheet = explicit.getWorksheet('商户A')!;
  assert.equal(explicitSheet.getRow(header + 1).getCell(explicitMetadata.columns.findIndex(column => column.key === 'business:moq') + 1).value, 100);
  assert.equal(explicitSheet.getRow(header + 1).getCell(explicitMetadata.columns.findIndex(column => column.key === 'business:notes') + 1).value, fields.notes);
  assert.equal(deleteProduct(owner,created.id,2).deleted,true);
  assert.throws(()=>getProduct(owner,created.id),/不存在/);assert.throws(()=>readPhoto(owner,photo.id),/不存在/);
});

test('extracts explicit procurement details without confusing carton dimensions or delivery ranges', () => {
  const { fields } = extractText('货号：YW-42，外箱尺寸：40×30×35cm，商品尺寸：高15cm，单箱体积：0.042m³，大货交期：18天，报价条款：FOB 宁波');
  assert.equal(fields.sku, 'YW-42'); assert.equal(fields.cartonDimensions, '40×30×35cm'); assert.equal(fields.dimensions, '高15cm');
  assert.equal(fields.cartonCbm, 0.042); assert.equal(fields.leadTimeDays, 18); assert.equal(fields.tradeTerms, 'FOB 宁波');
  assert.equal(extractText('外箱尺寸：40×30×35cm，大货交期：18–20天').fields.dimensions, undefined);
  assert.equal(extractText('大货交期：18–20天').fields.leadTimeDays, undefined);
  assert.equal(extractText('单价12元').fields.tradeTerms, undefined);
});


test('模型估算不填入商业字段，旧 estimates 响应兼容明确值', async () => {
  const { parseExtractionFields } = await import('../src/lib/extraction');
  const fields = parseExtractionFields({ name: '杯子', colors: '蓝色', material: null, dimensions: '10cm', weightG: 300, unitPrice: 12, currency: 'CNY', moq: null, cartonQty: null, estimates: ['weightG', 'dimensions'] });
  assert.equal(fields.name, '杯子'); assert.equal(fields.unitPrice, 12);
  assert.equal(fields.weightG, undefined); assert.equal(fields.dimensions, undefined);
});


test('兼容真实模型颜色列表，同时拒绝混合值、超长颜色及商业数值字符串', async () => {
  const { parseExtractionFields } = await import('../src/lib/extraction');
  const input = { name: '陶瓷杯', colors: ['白色', '蓝色', ' 白色 '], material: '陶瓷', dimensions: null, weightG: null, unitPrice: 12, currency: 'CNY', moq: 100, cartonQty: 48 };
  assert.deepEqual(parseExtractionFields(input), { name: '陶瓷杯', colors: '白色、蓝色', material: '陶瓷', unitPrice: 12, currency: 'CNY', moq: 100, cartonQty: 48 });
  assert.equal(parseExtractionFields({ ...input, colors: [] }).colors, '');
  for (const colors of [['白色', 3], [{ color: '白色' }], [''], ['白'.repeat(201)], Array(21).fill('白色')]) {
    assert.throws(() => parseExtractionFields({ ...input, colors }), /格式不正确/);
  }
  assert.throws(() => parseExtractionFields({ ...input, unitPrice: '12' }), /格式不正确/);
});
