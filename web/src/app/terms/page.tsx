import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms of Service - botook.ai',
  description: 'Terms of service for botook.ai',
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl border border-outline-variant/20 p-10 w-full max-w-2xl shadow-lg space-y-6">
        <h1 className="font-[Manrope] font-extrabold text-2xl text-on-surface">Terms of Service</h1>
        <p className="text-outline text-sm">Last updated: March 28, 2026</p>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">1. Acceptance of Terms</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            By using botook.ai, you agree to these Terms of Service. If you do not agree, please do not use the service.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">2. Service Description</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            botook.ai is a unified inbox that aggregates messages from multiple platforms (Feishu, Gmail, WeChat, etc.) into a single interface, with AI-assisted features for message management.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">3. User Responsibilities</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            You are responsible for maintaining the security of your account and any connected platform credentials. You agree not to use the service for any unlawful purpose.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">4. Data and Privacy</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            Your use of the service is also governed by our <a href="/privacy" className="text-primary underline">Privacy Policy</a>. By using the service, you consent to the collection and use of information as described therein.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">5. Limitation of Liability</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            The service is provided "as is" without warranties of any kind. We are not liable for any damages arising from your use of the service, including but not limited to data loss or service interruptions.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">6. Changes to Terms</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            We may update these terms from time to time. Continued use of the service after changes constitutes acceptance of the new terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-[Manrope] font-bold text-lg text-on-surface">7. Contact</h2>
          <p className="text-on-surface-variant text-sm leading-relaxed">
            For questions about these terms, contact us at <a href="mailto:yy@peekaboo.tech" className="text-primary underline">yy@peekaboo.tech</a>.
          </p>
        </section>

        <div className="pt-4 border-t border-outline-variant/20">
          <a href="/" className="text-primary text-sm hover:underline">← Back to botook.ai</a>
        </div>
      </div>
    </div>
  )
}
