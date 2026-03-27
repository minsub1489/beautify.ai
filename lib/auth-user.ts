import { headers } from 'next/headers';
import { getAuthSession, sessionToUserId } from '@/lib/auth';

const FALLBACK_USER_ID = process.env.BILLING_DEMO_USER_ID?.trim() || 'demo-user';

function sanitizeUserId(raw: string) {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

export async function getCurrentUserId() {
  const session = await getAuthSession();
  const sessionUserId = sessionToUserId(session);
  if (sessionUserId) return sessionUserId;

  const h = await headers();
  const headerUser = h.get('x-user-id')?.trim();
  if (headerUser) {
    const sanitized = sanitizeUserId(headerUser);
    if (sanitized) return sanitized;
  }
  return FALLBACK_USER_ID;
}
