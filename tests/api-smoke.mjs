import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import ExcelJS from "exceljs";

// Run only after npm run build. Test data never touches the user's .data directory.
const root=mkdtempSync(join(tmpdir(),"huoji-api-"));const port=process.env.TEST_PORT || "3197";
const server=spawn(process.execPath,["node_modules/next/dist/bin/next","start","-p",port,"--hostname","127.0.0.1"],{env:{...process.env,APP_DATA_DIR:root,MODEL_API_KEY:"",MODEL_NAME:""},stdio:["ignore","pipe","pipe"]});
let logs="";for(const stream of [server.stdout,server.stderr])stream.on("data",data=>{logs+=data.toString();});
const base=`http://127.0.0.1:${port}`;
try {
  let ready=false;
  for(let i=0;i<100;i++) {try {const r=await fetch(`${base}/api/config`);if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready,`Server startup failed: ${logs}`);
  const config=await (await fetch(`${base}/api/config`)).json();assert.equal(config.modelEnabled,false);
  let response=await fetch(`${base}/api/projects`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"API验收",market:"测试市场",date:"2026-10-02"})});assert.equal(response.status,201);const project=await response.json();
  const blocked=await fetch(`${base}/api/projects`,{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://foreign.example"},body:"{}"});assert.equal(blocked.status,400);
  const extraction=new FormData();extraction.set("description","陶瓷杯，12元一个，100个起订，单个300克，每箱24个");
  response=await fetch(`${base}/api/extract`,{method:"POST",body:extraction});assert.equal(response.status,200);const result=await response.json();assert.equal(result.mode,"rules");assert.equal(result.fields.weightG,300);assert.equal(result.fields.cartonQty,24);
  const image=await sharp({create:{width:80,height:80,channels:3,background:"#00aa88"}}).png().toBuffer();
  const form=new FormData();form.set("projectId",project.id);form.set("fields",JSON.stringify({name:"陶瓷杯",description:"单个300克",unitPrice:12,weightG:300,moq:100,confirmed:true}));form.append("photos",new Blob([image],{type:"image/png"}),"cup.png");
  response=await fetch(`${base}/api/products`,{method:"POST",body:form});assert.equal(response.status,201);const product=await response.json();assert.equal(product.photos.length,1);
  response=await fetch(`${base}${product.photos[0].url}`);assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"image/jpeg");
  const list=await (await fetch(`${base}/api/products?projectId=${project.id}`)).json();assert.equal(list.length,1);
  response=await fetch(`${base}/api/export?projectId=${project.id}`);assert.equal(response.status,200);const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));assert.equal(workbook.getWorksheet("看货记录").getImages().length,1);assert.equal(workbook.getWorksheet("看货记录").getCell("B2").value,"陶瓷杯");
  response=await fetch(`${base}/api/products/${product.id}`,{method:"DELETE"});assert.equal(response.status,200);response=await fetch(`${base}${product.photos[0].url}`);assert.equal(response.status,404);
  const demo=await (await fetch(`${base}/api/demo`,{method:"POST"})).json();assert.equal(demo.demo,true);const again=await (await fetch(`${base}/api/demo`,{method:"POST"})).json();assert.equal(again.id,demo.id);
  const examples=await (await fetch(`${base}/api/products?projectId=${demo.id}`)).json();assert.equal(examples.length,3);
  console.log("PASS: production API startup, project creation, origin validation, extraction, photo persistence, XLSX image export, deletion, and repeatable demo seeding.");
} finally {
  const exited=new Promise(resolve=>server.once("exit",resolve));server.kill("SIGTERM");await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(server.exitCode===null)server.kill("SIGKILL");rmSync(root,{recursive:true,force:true});
}
