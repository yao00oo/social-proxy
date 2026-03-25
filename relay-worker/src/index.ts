// Social Proxy Relay Worker — Cloudflare Worker
// 提供 OAuth 回调中转 + 飞书事件订阅接收
// 部署: cd relay-worker && npx wrangler deploy

export interface Env {
  DB: D1Database;
  ADMIN_SECRET: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function successHTML(title: string): Response {
  return new Response(`
    <html><body style="font-family:sans-serif;padding:40px;background:#0a0a0a;color:white">
      <h2>✅ ${title}</h2>
      <p>正在写入本地数据库，请回到配置页面...</p>
      <script>setTimeout(()=>window.close(),3000)</script>
    </body></html>
  `, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 通用 OAuth 回调：暂存 code，5分钟 TTL
async function handleOAuthCallback(env: Env, prefix: string, url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return new Response('<p>缺少 code 或 state</p>', { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  const expiry = Date.now() + 5 * 60 * 1000;
  await env.DB.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(`${prefix}_oauth_${state}`, JSON.stringify({ code, expiry })).run();

  return successHTML(`${prefix === 'gmail' ? 'Gmail' : '飞书'} 授权成功`);
}

// 通用 OAuth code 轮询：取到即删
async function handleOAuthCode(env: Env, prefix: string, url: URL): Promise<Response> {
  const state = url.searchParams.get('state');
  if (!state) return json({ error: 'Missing state' }, 400);

  const row = await env.DB.prepare(
    "SELECT value FROM kv WHERE key = ?"
  ).bind(`${prefix}_oauth_${state}`).first() as any;

  if (!row) return json({ code: null });

  const { code, expiry } = JSON.parse(row.value);
  if (Date.now() > expiry) {
    await env.DB.prepare("DELETE FROM kv WHERE key = ?").bind(`${prefix}_oauth_${state}`).run();
    return json({ error: 'Code expired' }, 410);
  }

  await env.DB.prepare("DELETE FROM kv WHERE key = ?").bind(`${prefix}_oauth_${state}`).run();
  return json({ code });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' },
      });
    }

    // Health check
    if (method === 'GET' && path === '/health') {
      return json({ ok: true, service: 'social-proxy-relay' });
    }

    // ── 飞书 OAuth ──────────────────────────────────
    if (method === 'GET' && path === '/feishu/callback') {
      return handleOAuthCallback(env, 'feishu', url);
    }
    if (method === 'GET' && path === '/feishu/code') {
      return handleOAuthCode(env, 'feishu', url);
    }

    // ── Gmail OAuth ─────────────────────────────────
    if (method === 'GET' && path === '/gmail/callback') {
      return handleOAuthCallback(env, 'gmail', url);
    }
    if (method === 'GET' && path === '/gmail/code') {
      return handleOAuthCode(env, 'gmail', url);
    }

    // ── 飞书事件订阅 ────────────────────────────────
    if (method === 'POST' && path === '/feishu/event') {
      const body = await request.json() as any;

      // URL verification challenge
      if (body.type === 'url_verification') {
        return json({ challenge: body.challenge });
      }

      // v2 event schema
      if (body.schema === '2.0' && body.header?.event_id) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO feishu_events (event_id, event_type, payload, ts) VALUES (?, ?, ?, ?)'
        ).bind(body.header.event_id, body.header.event_type || 'unknown', JSON.stringify(body), Date.now()).run();
      }

      return json({ ok: true });
    }

    // ── 飞书事件拉取 ────────────────────────────────
    if (method === 'GET' && path === '/feishu/events') {
      const consumer = url.searchParams.get('consumer') || 'default';

      const offsetRow = await env.DB.prepare(
        'SELECT last_id FROM feishu_event_offsets WHERE consumer = ?'
      ).bind(consumer).first() as any;
      const lastId = offsetRow?.last_id ?? 0;

      const events = await env.DB.prepare(
        'SELECT id, event_id, event_type, payload, ts FROM feishu_events WHERE id > ? ORDER BY id ASC LIMIT 50'
      ).bind(lastId).all();

      if (events.results.length > 0) {
        const newLastId = Math.max(...events.results.map((e: any) => e.id));
        await env.DB.prepare(
          'INSERT INTO feishu_event_offsets (consumer, last_id) VALUES (?, ?) ON CONFLICT(consumer) DO UPDATE SET last_id = excluded.last_id'
        ).bind(consumer, newLastId).run();
      }

      return json(events.results.map((e: any) => ({
        id: e.id,
        eventId: e.event_id,
        eventType: e.event_type,
        payload: JSON.parse(e.payload),
        ts: e.ts,
      })));
    }

    return json({ error: 'Not found' }, 404);
  },
};
