// GET /api/models — 返回可用的 AI 模型列表
import { NextResponse } from 'next/server'
import { AVAILABLE_MODELS } from '@/lib/agent'

export async function GET() {
  return NextResponse.json({ models: AVAILABLE_MODELS })
}
