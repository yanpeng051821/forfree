import { NextResponse } from "next/server";
import { modelEnabled } from "@/lib/extraction";
export async function GET() {return NextResponse.json({modelEnabled:modelEnabled()});}
