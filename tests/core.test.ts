import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import ExcelJS from "exceljs";
import { extractText, extractWithModel } from "../src/lib/extraction";
import { fieldsSchema, projectSchema } from "../src/lib/schema";
import { createProject, db, deleteProduct, getProduct, listProducts, prepareImage, readPhoto, saveProduct } from "../src/lib/db";
import { emptyFields } from "../src/lib/types";
import { exportWorkbook } from "../src/lib/export";

const originalDir=process.env.APP_DATA_DIR;
const root=mkdtempSync(join(tmpdir(),"huoji-tests-"));process.env.APP_DATA_DIR=root;
after(()=>{db().close();rmSync(root,{recursive:true,force:true});if(originalDir===undefined)delete process.env.APP_DATA_DIR;else process.env.APP_DATA_DIR=originalDir;});

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
  } finally {if(old===undefined)delete process.env.MODEL_BASE_URL;else process.env.MODEL_BASE_URL=old;}
});
test("rejects malformed and spoofed image files",async()=>{
  await assert.rejects(()=>prepareImage(new File(["invalid"],"bad.jpg",{type:"image/jpeg"})),/无法读取/);
  await assert.rejects(()=>prepareImage(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'],"spoof.jpg",{type:"image/jpeg"})),/无法读取/);
});
test("persists products and photos, validates ownership, exports images, and deletes",async()=>{
  const project=createProject({name:"测试任务",market:"测试市场",date:"2026-10-02"});
  const other=createProject({name:"另一个任务",market:"",date:"2026-10-02"});
  const source=await sharp({create:{width:80,height:100,channels:3,background:"#00aa88"}}).png().toBuffer();
  const prepared=await prepareImage(new File([new Uint8Array(source)],"cup.png",{type:"image/png"}));
  const created=await saveProduct(project.id,{...emptyFields,name:"=HYPERLINK(\"bad\")",supplier:"商户A",unitPrice:12,moq:100},[prepared]);
  assert.equal(created.photos.length,1);assert.ok(readPhoto(created.photos[0].id));assert.equal(listProducts(other.id).length,0);
  await assert.rejects(()=>saveProduct(other.id,{...emptyFields,name:"杯"},[],created.id),/商品不存在/);
  await assert.rejects(()=>saveProduct(project.id,{...emptyFields,name:"杯"},[],created.id,["foreign-photo"]),/归属无效/);
  const updated=await saveProduct(project.id,{...emptyFields,name:"=HYPERLINK(\"bad\")",unitPrice:15,confirmed:true},[],created.id,[created.photos[0].id]);
  assert.equal(updated.unitPrice,15);assert.equal(updated.photos.length,1);assert.equal(getProduct(created.id)?.confirmed,true);
  const exported=await exportWorkbook(project,listProducts(project.id));
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(exported as unknown as ExcelJS.Buffer);
  const sheet=workbook.getWorksheet("看货记录")!;
  assert.equal(sheet.rowCount,2);assert.equal(sheet.getCell("B2").value,'=HYPERLINK("bad")');assert.equal(sheet.getCell("H2").value,15);assert.equal(sheet.getImages().length,1);assert.equal(sheet.getCell("M2").value,"已确认");
  assert.equal(deleteProduct(created.id),true);assert.equal(getProduct(created.id),undefined);assert.equal(readPhoto(created.photos[0].id),null);
});
