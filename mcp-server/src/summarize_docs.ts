// 批量生成飞书文档摘要
// 运行: OPENROUTER_API_KEY=... DB_PATH=... node -r ts-node/register/transpile-only src/summarize_docs.ts

import OpenAI from 'openai'
import { getDb } from './db'

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

const MODEL = 'deepseek/deepseek-chat'

async function summarizeDoc(title: string, docType: string, content: string): Promise<string> {
  const trimmed = content.slice(0, 3000)
  const res = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `以下是飞书${docType === 'docx' ? '文档' : docType}「${title}」的内容片段。
用3-4句话写摘要，包含：文档用途/主题、主要内容要点、大致时间背景（如有）。语言简洁。

${trimmed}

摘要：`
    }]
  })
  return res.choices[0].message.content?.trim() ?? '生成失败'
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('请设置 OPENROUTER_API_KEY')
    process.exit(1)
  }

  const db = getDb()
  const docs = db.prepare(`
    SELECT doc_id, title, doc_type, content FROM feishu_docs
    WHERE summary IS NULL AND content IS NOT NULL AND content != ''
  `).all() as any[]

  const noContent = (db.prepare(`SELECT COUNT(*) as n FROM feishu_docs WHERE content IS NULL OR content = ''`).get() as any).n
  console.log(`待生成摘要: ${docs.length} 个，无内容跳过: ${noContent} 个`)

  const update = db.prepare(`UPDATE feishu_docs SET summary = ? WHERE doc_id = ?`)

  let ok = 0, fail = 0
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]
    process.stdout.write(`  [${i + 1}/${docs.length}] ${doc.title.slice(0, 30)}... `)
    try {
      const summary = await summarizeDoc(doc.title, doc.doc_type, doc.content)
      update.run(summary, doc.doc_id)
      console.log('✓')
      ok++
    } catch (e: any) {
      console.log(`✗ ${e.message?.slice(0, 60)}`)
      fail++
    }
    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 1000))
  }

  console.log(`\n完成：成功 ${ok}，失败 ${fail}`)
}

main().catch(console.error)
