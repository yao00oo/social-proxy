import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy - botook.ai',
  description: 'Privacy policy for botook.ai',
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl border border-outline-variant/20 p-10 w-full max-w-2xl shadow-lg space-y-6">
        <h1 className="font-[Manrope] font-extrabold text-2xl text-on-surface">Privacy Policy</h1>
        <p className="text-outline text-sm">Last updated: March 28, 2026</p>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">1. Information We Collect</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            When you use botook.ai, we collect information you provide directly, including your Google account profile (name, email) for authentication, and messaging data you choose to sync from connected platforms (Feishu, Gmail, etc.). We only access data you explicitly authorize.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">2. How We Use Your Information</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            We use your information to provide the botook.ai service: syncing messages across platforms, displaying them in a unified inbox, and enabling AI-assisted responses. We do not sell your data to third parties.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">3. Data Storage</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            Your data is stored on secure cloud servers (Neon PostgreSQL). OAuth tokens are stored encrypted. You can delete your data at any time by disconnecting a data source in Settings.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">4. Third-Party Services</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            We integrate with third-party platforms (Google, Feishu) via their official APIs using OAuth 2.0. We only request the minimum permissions necessary. We use OpenRouter for AI features — your messages may be processed by AI models to generate summaries and suggested replies.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">5. Your Rights</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            You can revoke access to any connected platform at any time. You can request deletion of all your data by contacting us. You can export your data through the API.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">6. Contact</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            For privacy-related inquiries, contact us at <a href="mailto:yy@peekaboo.tech" className="text-primary underline">yy@peekaboo.tech</a>.
          </p>
        </section>

        <div className="pt-4 border-t border-outline-variant/20">
          <a href="/" className="text-primary text-sm hover:underline">← Back to botook.ai</a>
        </div>
      </div>
    </div>
  )
}
