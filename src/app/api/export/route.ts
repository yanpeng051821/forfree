import { getProject, listProducts } from "@/lib/db";
import { exportWorkbook } from "@/lib/export";
import { errorResponse } from "@/lib/http";
export const runtime="nodejs";
export async function GET(request:Request) {
  const project=getProject(new URL(request.url).searchParams.get("projectId") || "");
  if(!project) return new Response("看货任务不存在",{status:404});
  try {
    const bytes=await exportWorkbook(project,listProducts(project.id));
    const name=encodeURIComponent(`${project.name.replace(/[\/\\\r\n]/g,"-")}-${project.date}.xlsx`);
    return new Response(new Uint8Array(bytes),{headers:{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename*=UTF-8''${name}`,"Cache-Control":"no-store"}});
  } catch(error) {return errorResponse(error,500);}
}
