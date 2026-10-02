import { NextResponse } from "next/server";
import sharp from "sharp";
import { createProject, listProjects, saveProduct } from "@/lib/db";
import { emptyFields } from "@/lib/types";
import { assertSameOrigin, errorResponse } from "@/lib/http";
export const runtime="nodejs";
const drawings=[
  '<path d="M170 190h155v155q0 50-77 50t-78-50z" fill="#dfb3a3"/><path d="M325 205h24q62 0 48 67t-72 38" fill="none" stroke="#dfb3a3" stroke-width="24"/><ellipse cx="247" cy="190" rx="77" ry="18" fill="#f5ddd0"/><ellipse cx="247" cy="190" rx="58" ry="10" fill="#a07869"/>',
  '<path d="M156 220h200l20 182H136z" fill="#e0d5ba"/><path d="M203 241v-72q0-67 53-67t53 67v72" fill="none" stroke="#b9a88c" stroke-width="15"/><path d="M175 256v112M337 256v112" stroke="#cabe9f" stroke-width="2"/>',
  '<rect x="210" y="138" width="90" height="260" rx="32" fill="#bdc9c6"/><rect x="212" y="111" width="86" height="52" rx="16" fill="#526b64"/><rect x="226" y="176" width="17" height="185" rx="8" fill="#e6eeeb"/>',
];
let pending:Promise<ReturnType<typeof createProject>>|null=null;
async function seed() {
  const existing=listProjects().find(p=>p.demo);if(existing) return existing;
  const photos=await Promise.all(drawings.map(drawing=>sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#f1efe8"/><ellipse cx="256" cy="416" rx="132" ry="18" fill="#e4e2d8"/>${drawing}<text x="256" y="475" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#839087">DEMO ILLUSTRATION</text></svg>`)).jpeg().toBuffer()));
  const project=createProject({name:"义乌春季选品 · 模拟",market:"国际商贸城 · 模拟",date:new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Shanghai"})},true);
  const values=[
    {name:"陶瓷杯",supplier:"青禾家居 · 模拟商户",colors:"红色、白色",material:"陶瓷",unitPrice:12,moq:100,weightG:300,cartonQty:24,description:"陶瓷杯，红白两色，12元一个，100个起订，单个300克，每箱24个。",confirmed:true},
    {name:"帆布袋",supplier:"原野布艺 · 模拟商户",colors:"米白色",material:"帆布",unitPrice:8,moq:200,dimensions:"35×40cm",description:"帆布袋，米白色，8元一个，200个起订，尺寸35×40cm。"},
    {name:"不锈钢保温杯",supplier:"青禾家居 · 模拟商户",colors:"银色",material:"不锈钢",unitPrice:25,moq:50,description:"不锈钢保温杯，银色，25元一个，50个起订。"},
  ];
  for(const [index,value] of values.entries()) await saveProduct(project.id,{...emptyFields,...value,notes:"模拟数据；图片为示意插画。"},[{name:"示例插画.jpg",bytes:photos[index]}]);
  return project;
}
export async function POST(request:Request) {
  try {assertSameOrigin(request);pending ||= seed().finally(()=>{pending=null;});return NextResponse.json(await pending);}
  catch(error) {return errorResponse(error);}
}
