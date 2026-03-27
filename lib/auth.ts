import type { NextAuthOptions } from 'next-auth';
import { getServerSession } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';

function hasValue(value: string | undefined) {
  return Boolean(value && value.trim());
}

const providers: NextAuthOptions['providers'] = [];

if (hasValue(process.env.GOOGLE_CLIENT_ID) && hasValue(process.env.GOOGLE_CLIENT_SECRET)) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    }),
  );
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers,
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/',
  },
  callbacks: {
    async session({ session, token }) {
      if (session.user) {
        session.user.name = session.user.name || token.name || '사용자';
        session.user.email = session.user.email || (typeof token.email === 'string' ? token.email : null) || undefined;
      }
      return session;
    },
  },
};

export async function getAuthSession() {
  return getServerSession(authOptions);
}

export function sessionToUserId(session: Awaited<ReturnType<typeof getAuthSession>>) {
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email) return '';
  return `user_${email.replace(/[^a-z0-9._-]/g, '_')}`.slice(0, 64);
}
