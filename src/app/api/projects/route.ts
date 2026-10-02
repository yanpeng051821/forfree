import { NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/db";
import { projectSchema } from "@/lib/schema";
import { assertSameOrigin, errorResponse } from "@/lib/http";
export const runtime="nodejs";
export async function GET() {return NextResponse.json(listProjects());}
export async function POST(request:Request) {
  try {assertSameOrigin(request);const values=projectSchema.parse(await request.json());return NextResponse.json(createProject(values),{status:201});}
  catch(error) {return errorResponse(error);}
}
