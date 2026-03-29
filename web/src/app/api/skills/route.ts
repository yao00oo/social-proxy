// CRUD API for skills
import { NextRequest, NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { query, queryOne, exec } from '@/lib/db'

// Parse YAML frontmatter from markdown content (between --- markers)
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {}
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return { frontmatter, body: content }

  const yamlBlock = match[1]
  const body = match[2]

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let value = line.slice(colonIdx + 1).trim()
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) frontmatter[key] = value
  }

  return { frontmatter, body }
}

// GET /api/skills — List all skills for current user
// GET /api/skills?id=123 — Get full skill content
export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const id = req.nextUrl.searchParams.get('id')

  if (id) {
    // Get single skill with full content
    const skill = await queryOne<any>(
      'SELECT id, name, description, content, enabled, source_url, metadata, created_at FROM skills WHERE id = ? AND user_id = ?',
      [parseInt(id), userId]
    )
    if (!skill) return NextResponse.json({ error: '技能未找到' }, { status: 404 })
    return NextResponse.json({ skill })
  }

  // List all skills (without full content)
  const skills = await query<any>(
    'SELECT id, name, description, enabled, source_url, created_at FROM skills WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  )
  return NextResponse.json({ skills })
}

// POST /api/skills — Install a skill
export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const body = await req.json()

  let name: string
  let description: string | null = null
  let content: string
  let sourceUrl: string | null = null
  let metadata: Record<string, any> = {}

  if (body.url) {
    // Fetch SKILL.md from URL
    sourceUrl = body.url
    try {
      const res = await fetch(body.url)
      if (!res.ok) return NextResponse.json({ error: `无法获取 URL: ${res.status}` }, { status: 400 })
      content = await res.text()
    } catch (e: any) {
      return NextResponse.json({ error: `获取 URL 失败: ${e.message}` }, { status: 400 })
    }

    // Parse frontmatter
    const parsed = parseFrontmatter(content)
    name = parsed.frontmatter.name || body.name
    description = parsed.frontmatter.description || null
    metadata = parsed.frontmatter

    if (!name) return NextResponse.json({ error: '技能名称缺失，URL 内容中未找到 name 字段' }, { status: 400 })
  } else {
    // Direct install
    content = body.content
    if (!content) return NextResponse.json({ error: '缺少 content 字段' }, { status: 400 })

    // Parse frontmatter from content
    const parsed = parseFrontmatter(content)
    name = body.name || parsed.frontmatter.name
    description = body.description || parsed.frontmatter.description || null
    sourceUrl = body.sourceUrl || null
    metadata = parsed.frontmatter

    if (!name) return NextResponse.json({ error: '缺少技能名称 (name)' }, { status: 400 })
  }

  // Upsert: ON CONFLICT (user_id, name) DO UPDATE
  await exec(
    `INSERT INTO skills (user_id, name, description, content, source_url, metadata)
     VALUES (?, ?, ?, ?, ?, ?::jsonb)
     ON CONFLICT (user_id, name) DO UPDATE SET
       description = EXCLUDED.description,
       content = EXCLUDED.content,
       source_url = EXCLUDED.source_url,
       metadata = EXCLUDED.metadata,
       enabled = 1`,
    [userId, name, description, content, sourceUrl, JSON.stringify(metadata)]
  )

  const skill = await queryOne<{ id: number; name: string }>(
    'SELECT id, name FROM skills WHERE user_id = ? AND name = ?',
    [userId, name]
  )

  return NextResponse.json({ ok: true, skill })
}

// DELETE /api/skills?id=123 — Uninstall a skill
export async function DELETE(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: '缺少 id 参数' }, { status: 400 })

  await exec('DELETE FROM skills WHERE id = ? AND user_id = ?', [parseInt(id), userId])
  return NextResponse.json({ ok: true })
}
