'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, LogOut } from 'lucide-react';
import { getProviders, signIn, signOut, useSession } from 'next-auth/react';

type ProviderMap = Record<string, { id: string; name: string }>;

type AuthControlsProps = {
  loadingBalance: boolean;
  creditBalance: string;
  billingStatus?: string;
  autoRechargeEnabled: boolean;
  onQuickCharge: () => void;
  onToggleAutoRecharge: (checked: boolean) => void;
};

export function AuthControls({
  loadingBalance,
  creditBalance,
  billingStatus,
  autoRechargeEnabled,
  onQuickCharge,
  onToggleAutoRecharge,
}: AuthControlsProps) {
  const { data: session, status } = useSession();
  const [providers, setProviders] = useState<ProviderMap>({});
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [menuOpen]);

  const oauthButtons = useMemo(
    () => [{ id: 'google', label: '로그인' }].filter((button) => providers[button.id]),
    [providers],
  );

  if (status === 'loading' || loadingProviders) {
    return <div className="authStatus">로그인 상태 확인 중...</div>;
  }

  if (session?.user) {
    const displayName = session.user.name || session.user.email || '사용자';
    const avatarInitial = displayName.trim().charAt(0).toUpperCase() || 'U';

    return (
      <div className="authControls accountControls" ref={menuRef}>
        <button
          className={`accountButton ${menuOpen ? 'open' : ''}`}
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          aria-expanded={menuOpen}
          aria-label="마이페이지 열기"
        >
          <div className="accountAvatar" aria-hidden="true">
            {session.user.image ? <img src={session.user.image} alt="" className="accountAvatarImage" referrerPolicy="no-referrer" /> : avatarInitial}
          </div>
          <div className="accountButtonText">
            <div className="accountButtonName">{displayName}</div>
          </div>
          <ChevronDown size={16} className={`accountButtonChevron ${menuOpen ? 'open' : ''}`} />
        </button>

        {menuOpen ? (
          <div className="accountPanel">
            <div className="accountProfile">
              <div className="accountProfileName">{displayName}</div>
              {session.user.email ? <div className="accountProfileEmail">{session.user.email}</div> : null}
            </div>

            <div className="accountBillingCard">
              <div className="billingBalance">크레딧 {loadingBalance ? '불러오는 중...' : Number(creditBalance || '0').toLocaleString()}</div>
              <button className="button secondary" type="button" onClick={onQuickCharge}>
                + 충전
              </button>
              <label className="autoRechargeToggle">
                <input
                  type="checkbox"
                  checked={autoRechargeEnabled}
                  onChange={(event) => onToggleAutoRecharge(event.target.checked)}
                />
                자동충전
              </label>
            </div>

            {billingStatus ? <div className="authStatus">{billingStatus}</div> : null}

            <button className="button secondary accountLogoutButton" type="button" onClick={() => void signOut({ callbackUrl: '/' })}>
              <LogOut size={16} />
              로그아웃
            </button>
          </div>
        ) : null}
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
