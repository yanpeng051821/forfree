import { NextResponse } from "next/server";
import { prepareImage, readPhoto } from "@/lib/db";
import { extractText, extractWithModel, modelEnabled } from "@/lib/extraction";
import { assertSameOrigin, errorResponse } from "@/lib/http";
export const runtime="nodejs";
export async function POST(request:Request) {
  try {
    assertSameOrigin(request);
    const form=await request.formData();const text=String(form.get("description") || "");
    if(text.length>10000) throw new Error("描述最多10000字");
    if(!modelEnabled()) {
      if(!text.trim()) throw new Error("请先输入商品描述；文字整理不会读取照片。");
      return NextResponse.json(extractText(text));
    }
    const files=form.getAll("photos").filter((f):f is File=>f instanceof File);
    const existing=JSON.parse(String(form.get("photoIds") || "[]"));
    if(!Array.isArray(existing)||existing.some(id=>typeof id!=="string")||existing.length+files.length>6) throw new Error("最多整理6张照片");
    if(!text.trim()&&!files.length&&!existing.length) throw new Error("请添加照片或商品描述");
    const prepared=await Promise.all(files.map(prepareImage));
    const buffers=[...prepared.map(p=>p.bytes),...existing.map((id:string)=>{const bytes=readPhoto(id);if(!bytes) throw new Error("照片不存在，请重新选择");return bytes;})];
    return NextResponse.json(await extractWithModel(text,buffers.map(bytes=>`data:image/jpeg;base64,${bytes.toString("base64")}`)));
  } catch(error) {
    if(error instanceof SyntaxError) return errorResponse(new Error("整理结果格式不正确，请重试或手动填写。"),502);
    if(error instanceof Error && /timeout|aborted/i.test(error.message)) return errorResponse(new Error("整理超时，输入已保留，请重试或手动填写。"),504);
    return errorResponse(error);
  }
}
