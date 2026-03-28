import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Install Social Proxy MCP - botook.ai',
  description: 'Connect your AI tools (Claude Code, Cursor, OpenClaw) to Social Proxy for unified messaging.',
}

export default function InstallPage() {
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl border border-outline-variant/20 p-10 w-full max-w-2xl shadow-lg space-y-8">
        <div className="text-center">
          <div className="w-14 h-14 bg-primary-container rounded-2xl flex items-center justify-center text-white font-black text-2xl font-[Manrope] mx-auto mb-3">S</div>
          <h1 className="font-[Manrope] font-extrabold text-2xl text-on-surface">Install Social Proxy MCP</h1>
          <p className="text-outline text-sm mt-2">Connect your AI tools to your unified inbox at botook.ai</p>
        </div>

        {/* Quick Install */}
        <section className="space-y-3">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">Quick Install</h2>
          <p className="text-on-surface-variant text-sm">Run this single command in your terminal. It will guide you through authentication and configuration.</p>
          <pre className="bg-surface-container rounded-xl p-4 text-sm font-mono text-on-surface overflow-x-auto border border-outline-variant/20">
npx social-proxy-mcp@latest setup
          </pre>
        </section>

        {/* What it does */}
        <section className="space-y-3">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">What It Does</h2>
          <ul className="text-on-surface-variant text-sm space-y-2 list-disc list-inside">
            <li>Opens botook.ai/connect in your browser to authenticate</li>
            <li>You confirm access and get a one-time code</li>
            <li>Paste the code back in your terminal</li>
            <li>Auto-configures your AI tool (Claude Code, Cursor, or OpenClaw)</li>
          </ul>
        </section>

        {/* Manual Configuration */}
        <section className="space-y-4">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">Manual Configuration</h2>
          <p className="text-on-surface-variant text-sm">
            If you prefer to configure manually, add the following MCP server config to your tool. Replace <code className="bg-surface-container px-1.5 py-0.5 rounded text-xs">DATABASE_URL</code> with your Neon PostgreSQL connection string (get it from botook.ai/connect after login).
          </p>

          {/* Claude Code */}
          <div className="space-y-2">
            <h3 className="font-semibold text-sm text-on-surface">Claude Code</h3>
            <p className="text-outline text-xs">Add to <code className="bg-surface-container px-1 py-0.5 rounded">~/.claude.json</code> or run <code className="bg-surface-container px-1 py-0.5 rounded">claude mcp add</code></p>
            <pre className="bg-surface-container rounded-xl p-4 text-xs font-mono text-on-surface overflow-x-auto border border-outline-variant/20">{`{
  "mcpServers": {
    "social-proxy": {
      "command": "npx",
      "args": ["-y", "social-proxy-mcp@latest"],
      "env": {
        "DATABASE_URL": "your-neon-database-url"
      }
    }
  }
}`}</pre>
          </div>

          {/* Cursor */}
          <div className="space-y-2">
            <h3 className="font-semibold text-sm text-on-surface">Cursor</h3>
            <p className="text-outline text-xs">Add to <code className="bg-surface-container px-1 py-0.5 rounded">.cursor/mcp.json</code> in your project root</p>
            <pre className="bg-surface-container rounded-xl p-4 text-xs font-mono text-on-surface overflow-x-auto border border-outline-variant/20">{`{
  "mcpServers": {
    "social-proxy": {
      "command": "npx",
      "args": ["-y", "social-proxy-mcp@latest"],
      "env": {
        "DATABASE_URL": "your-neon-database-url"
      }
    }
  }
}`}</pre>
          </div>

          {/* OpenClaw */}
          <div className="space-y-2">
            <h3 className="font-semibold text-sm text-on-surface">OpenClaw</h3>
            <p className="text-outline text-xs">Add to <code className="bg-surface-container px-1 py-0.5 rounded">~/.openclaw/mcp.json</code></p>
            <pre className="bg-surface-container rounded-xl p-4 text-xs font-mono text-on-surface overflow-x-auto border border-outline-variant/20">{`{
  "mcpServers": {
    "social-proxy": {
      "command": "npx",
      "args": ["-y", "social-proxy-mcp@latest"],
      "env": {
        "DATABASE_URL": "your-neon-database-url"
      }
    }
  }
}`}</pre>
          </div>
        </section>

        {/* Help */}
        <section className="text-center text-outline text-xs space-y-1 pt-4 border-t border-outline-variant/10">
          <p>Need help? Visit <a href="https://botook.ai" className="underline">botook.ai</a></p>
          <p>Social Proxy - AI-powered unified inbox for all your messaging platforms</p>
        </section>
      </div>
    </div>
  )
}
