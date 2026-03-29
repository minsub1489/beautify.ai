'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, ChevronDown, LogOut, UserRound, WalletCards, Zap } from 'lucide-react';
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
  const balanceValue = Number(creditBalance || '0');
  const formattedBalance = loadingBalance ? '...' : balanceValue.toLocaleString();
  const creditStateLabel = loadingBalance ? '확인 중' : balanceValue > 0 ? '사용 가능' : '부족';
  const creditStateDetail = autoRechargeEnabled ? '자동충전 켜짐' : '자동충전 꺼짐';

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
            <div className="accountButtonMeta">마이페이지</div>
          </div>
          <ChevronDown size={16} className={`accountButtonChevron ${menuOpen ? 'open' : ''}`} />
        </button>

        {menuOpen ? (
          <div className="accountPanel">
            <div className="accountProfile accountProfileCard">
              <div className="accountProfileIdentity">
                <div className="accountAvatar accountAvatarLarge" aria-hidden="true">
                  {session.user.image ? <img src={session.user.image} alt="" className="accountAvatarImage" referrerPolicy="no-referrer" /> : avatarInitial}
                </div>
                <div className="accountProfileText">
                  <div className="accountProfileName">{displayName}</div>
                  <div className="accountProfileRole">Beautify 사용자</div>
                  {session.user.email ? <div className="accountProfileEmail">{session.user.email}</div> : null}
                </div>
              </div>
              <div className="accountProfileBadge">
                <BadgeCheck size={16} />
                로그인됨
              </div>
            </div>

            <div className="accountBillingCard">
              <div className="accountBillingHeader">
                <div className="accountBillingTitle">현재 크레딧 현황</div>
                <div className="accountBillingLink">마이페이지</div>
              </div>

              <div className="accountStatsGrid">
                <div className="accountStatCard accountStatCardPrimary">
                  <div className="accountStatLabel">보유 크레딧</div>
                  <div className="accountStatValue">{formattedBalance}</div>
                </div>
                <div className="accountStatCard">
                  <div className="accountStatLabel">상태</div>
                  <div className="accountStatValue accountStatValueCompact">{creditStateLabel}</div>
                  <div className="accountStatHint">{creditStateDetail}</div>
                </div>
              </div>

              <div className="accountBillingNote">
                <WalletCards size={15} />
                필기와 퀴즈 생성에만 크레딧이 사용됩니다.
              </div>

              <button className="accountChargeButton" type="button" onClick={onQuickCharge}>
                <Zap size={16} />
                크레딧 추가 충전
              </button>

              <div className="accountActionRows">
                <label className="accountToggleRow">
                  <div className="accountActionText">
                    <span className="accountActionTitle">자동충전</span>
                    <span className="accountActionMeta">{autoRechargeEnabled ? '부족해지면 자동으로 충전돼요.' : '필요할 때 수동으로 충전해 주세요.'}</span>
                  </div>
                  <span className={`accountToggleSwitch ${autoRechargeEnabled ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={autoRechargeEnabled}
                      onChange={(event) => onToggleAutoRecharge(event.target.checked)}
                    />
                    <span className="accountToggleKnob" aria-hidden="true" />
                  </span>
                </label>
              </div>

              {billingStatus ? <div className="accountBillingStatus">{billingStatus}</div> : null}
            </div>

            <div className="accountFooterActions">
              <button className="accountFooterButton accountLogoutButton" type="button" onClick={() => void signOut({ callbackUrl: '/' })}>
                <LogOut size={16} />
                로그아웃
              </button>
              <button
                className="accountFooterButton"
                type="button"
                onClick={() => setMenuOpen(false)}
              >
                <UserRound size={16} />
                닫기
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="authControls">
      {oauthButtons.length ? (
        oauthButtons.map((provider) => (
          <button key={provider.id} className="button secondary accountLoginButton" type="button" onClick={() => void signIn(provider.id)}>
            <UserRound size={16} />
            {provider.label}
          </button>
        ))
      ) : (
        <div className="authStatus">OAuth 설정값을 넣으면 로그인 버튼이 활성화됩니다.</div>
      )}
    </div>
  );
}
