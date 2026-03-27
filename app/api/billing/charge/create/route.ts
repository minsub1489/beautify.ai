import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUserId } from '@/lib/auth-user';
import { chargeCreateSchema } from '@/lib/validators';
import { assertWithinRateLimit } from '@/lib/rate-limit';

export async function POST(req: Request) {
  try {
    const userId = await getCurrentUserId();
    assertWithinRateLimit(userId, 'billing-charge-create');
    const body = await req.json().catch(() => ({}));
    const parsed = chargeCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { amountKrw, creditAmount, provider, idempotencyKey } = parsed.data;
    const order = await prisma.paymentOrder.upsert({
      where: { idempotencyKey },
      create: {
        userId,
        provider,
        status: 'pending',
        amountKrw: BigInt(amountKrw),
        creditAmount: BigInt(creditAmount),
        idempotencyKey,
        providerPaymentId: null,
      },
      update: {},
    });
    return NextResponse.json({
      ok: true,
      orderId: order.id,
      provider,
      amountKrw,
      creditAmount,
      status: order.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '충전 생성 중 오류가 발생했습니다.';
    const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: unknown }).status) || 500 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
