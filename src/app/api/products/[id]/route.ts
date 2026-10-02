import { NextResponse } from "next/server";
import { deleteProduct, getProduct } from "@/lib/db";
import { assertSameOrigin, errorResponse } from "@/lib/http";
export const runtime="nodejs";
export async function GET(_:Request,{params}:{params:Promise<{id:string}>}) {
  const product=getProduct((await params).id);
  return product ? NextResponse.json(product) : NextResponse.json({error:"商品不存在"},{status:404});
}
export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}) {
  try {assertSameOrigin(request);return deleteProduct((await params).id) ? NextResponse.json({ok:true}) : NextResponse.json({error:"商品不存在"},{status:404});}
  catch(error) {return errorResponse(error);}
}
