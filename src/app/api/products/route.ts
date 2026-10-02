import { NextResponse } from "next/server";
import { getProject, listProducts, prepareImage, saveProduct } from "@/lib/db";
import { fieldsSchema } from "@/lib/schema";
import { assertSameOrigin, errorResponse } from "@/lib/http";
export const runtime="nodejs";
export async function GET(request:Request) {
  const projectId=new URL(request.url).searchParams.get("projectId") || "";
  if(!getProject(projectId)) return NextResponse.json({error:"看货任务不存在"},{status:404});
  return NextResponse.json(listProducts(projectId));
}
export async function POST(request:Request) {
  try {
    assertSameOrigin(request);
    const form=await request.formData();
    const fields=fieldsSchema.parse(JSON.parse(String(form.get("fields"))));
    const files=form.getAll("photos").filter((f):f is File=>f instanceof File);
    if(files.length>6) throw new Error("每件商品最多6张照片");
    const uploads=await Promise.all(files.map(prepareImage));
    const keep=JSON.parse(String(form.get("keepPhotoIds") || "[]"));
    if(!Array.isArray(keep)||keep.some(id=>typeof id!=="string")) throw new Error("照片归属无效");
    const product=await saveProduct(String(form.get("projectId") || ""),fields,uploads,String(form.get("id") || "") || undefined,keep);
    return NextResponse.json(product,{status:201});
  } catch(error) {return errorResponse(error);}
}
