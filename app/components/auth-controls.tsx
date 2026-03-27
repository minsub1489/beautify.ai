'use client';

import { useEffect, useMemo, useState } from 'react';
import { getProviders, signIn, signOut, useSession } from 'next-auth/react';

type ProviderMap = Record<string, { id: string; name: string }>;

export function AuthControls() {
  const { data: session, status } = useSession();
  const [providers, setProviders] = useState<ProviderMap>({});
  const [loadingProviders, setLoadingProviders] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function loadProviders() {
      setLoadingProviders(true);
      try {
        const loaded = await getProviders();
        if (!mounted) return;
        setProviders((loaded || {}) as ProviderMap);
      } finally {
        if (mounted) setLoadingProviders(false);
      }
    }
    void loadProviders();
    return () => {
      mounted = false;
    };
  }, []);

  const oauthButtons = useMemo(
    () => [{ id: 'google', label: 'Google 로그인' }].filter((button) => providers[button.id]),
    [providers],
  );

  if (status === 'loading' || loadingProviders) {
    return <div className="authStatus">로그인 상태 확인 중...</div>;
  }

  if (session?.user) {
    return (
      <div className="authControls">
        <div className="authStatus">{session.user.name || session.user.email || '로그인 사용자'}</div>
        <button className="button secondary" type="button" onClick={() => void signOut({ callbackUrl: '/' })}>
          로그아웃
        </button>
      </div>
    );
  }

  return (
    <div className="authControls">
      {oauthButtons.length ? (
        oauthButtons.map((provider) => (
          <button key={provider.id} className="button secondary" type="button" onClick={() => void signIn(provider.id)}>
            {provider.label}
          </button>
        ))
      ) : (
        <div className="authStatus">OAuth 설정값을 넣으면 로그인 버튼이 활성화됩니다.</div>
      )}
    </div>
  );
}
