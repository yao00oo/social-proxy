'use client'

import { useRouter } from 'next/navigation'

export default function ContactDetailPage() {
  const router = useRouter()
  // Redirect to main page — all interaction now happens in the 3-column layout
  router.replace('/')
  return null
}
