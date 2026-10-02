import { NextResponse } from "next/server";
import { ZodError } from "zod";
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Error("请从当前应用提交请求");
}
export function errorResponse(error: unknown, status=400) {
  const message = error instanceof ZodError ? error.issues[0]?.message || "输入格式不正确" : error instanceof Error ? error.message : "操作失败，请重试";
  return NextResponse.json({error:message},{status});
}
