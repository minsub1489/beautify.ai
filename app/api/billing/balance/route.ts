import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUserId } from '@/lib/auth-user';
import { ensureCreditAccount, getBalance } from '@/lib/billing/ledger';
import { ensureBillingBootstrap } from '@/lib/billing/bootstrap';
import { assertWithinRateLimit } from '@/lib/rate-limit';

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    assertWithinRateLimit(userId, 'billing-balance');
    await ensureBillingBootstrap();
    await ensureCreditAccount({ userId });

    const [balance, autoRecharge] = await Promise.all([
      getBalance(userId),
      prisma.autoRechargeSetting.findUnique({ where: { userId } }),
    ]);

    return NextResponse.json({
      userId,
      balance: balance.toString(),
      autoRecharge: autoRecharge
        ? {
            enabled: autoRecharge.enabled,
            threshold: autoRecharge.threshold.toString(),
            rechargeAmountKrw: autoRecharge.rechargeAmountKrw.toString(),
            rechargeCreditAmount: autoRecharge.rechargeCreditAmount.toString(),
            paymentMethodRef: autoRecharge.paymentMethodRef || '',
          }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '잔액 조회 중 오류가 발생했습니다.';
    const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: unknown }).status) || 500 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

