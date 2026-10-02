import { readPhoto } from "@/lib/db";
export const runtime="nodejs";
export async function GET(_:Request,{params}:{params:Promise<{id:string}>}) {
  const bytes=readPhoto((await params).id);
  return bytes ? new Response(new Uint8Array(bytes),{headers:{"Content-Type":"image/jpeg","Cache-Control":"private, max-age=86400","X-Content-Type-Options":"nosniff"}}) : new Response("照片不存在",{status:404});
}
