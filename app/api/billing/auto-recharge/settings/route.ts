import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUserId } from '@/lib/auth-user';
import { autoRechargeSettingSchema } from '@/lib/validators';
import { assertWithinRateLimit } from '@/lib/rate-limit';

export async function POST(req: Request) {
  try {
    const userId = await getCurrentUserId();
    assertWithinRateLimit(userId, 'billing-auto-recharge');
    const body = await req.json().catch(() => ({}));
    const parsed = autoRechargeSettingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const saved = await prisma.autoRechargeSetting.upsert({
      where: { userId },
      create: {
        userId,
        enabled: parsed.data.enabled,
        threshold: BigInt(parsed.data.threshold),
        rechargeAmountKrw: BigInt(parsed.data.rechargeAmountKrw),
        rechargeCreditAmount: BigInt(parsed.data.rechargeCreditAmount),
        paymentMethodRef: parsed.data.paymentMethodRef || null,
      },
      update: {
        enabled: parsed.data.enabled,
        threshold: BigInt(parsed.data.threshold),
        rechargeAmountKrw: BigInt(parsed.data.rechargeAmountKrw),
        rechargeCreditAmount: BigInt(parsed.data.rechargeCreditAmount),
        paymentMethodRef: parsed.data.paymentMethodRef || null,
      },
    });

    return NextResponse.json({
      ok: true,
      autoRecharge: {
        enabled: saved.enabled,
        threshold: saved.threshold.toString(),
        rechargeAmountKrw: saved.rechargeAmountKrw.toString(),
        rechargeCreditAmount: saved.rechargeCreditAmount.toString(),
        paymentMethodRef: saved.paymentMethodRef || '',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '자동충전 설정 중 오류가 발생했습니다.';
    const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: unknown }).status) || 500 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

