import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { applyLedgerEntry } from '@/lib/billing/ledger';

type MockWebhookPayload = {
  eventId?: string;
  userId?: string;
  paymentOrderId?: string;
  providerPaymentId?: string;
  amountKrw?: number;
  creditAmount?: number;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as MockWebhookPayload;
    const eventId = String(body.eventId || '').trim();
    const userId = String(body.userId || '').trim();
    const paymentOrderId = String(body.paymentOrderId || '').trim();
    const providerPaymentId = String(body.providerPaymentId || '').trim() || `mockpay-${Date.now()}`;
    const amountKrw = Number(body.amountKrw || 0);
    const creditAmount = Number(body.creditAmount || 0);

    if (!eventId || !creditAmount || !amountKrw) {
      return NextResponse.json({ error: 'eventId, amountKrw, creditAmount가 필요합니다.' }, { status: 400 });
    }

    const event = await prisma.paymentWebhookEvent.upsert({
      where: { provider_providerEventId: { provider: 'mockpay', providerEventId: eventId } },
      create: {
        provider: 'mockpay',
        providerEventId: eventId,
        payload: body,
        processed: false,
      },
      update: {},
    });

    if (event.processed) {
      return NextResponse.json({ ok: true, deduped: true });
    }

    const order = paymentOrderId
      ? await prisma.paymentOrder.update({
          where: { id: paymentOrderId },
          data: {
            status: 'paid',
            providerPaymentId,
            paidAt: new Date(),
          },
        })
      : await prisma.paymentOrder.create({
          data: {
            userId: userId || 'demo-user',
            provider: 'mockpay',
            providerPaymentId,
            status: 'paid',
            amountKrw: BigInt(amountKrw),
            creditAmount: BigInt(creditAmount),
            idempotencyKey: `webhook-order:${eventId}`,
            paidAt: new Date(),
          },
        });

    await applyLedgerEntry({
      userId: order.userId,
      type: 'charge',
      amount: BigInt(creditAmount),
      reason: '웹훅 충전 반영',
      paymentOrderId: order.id,
      idempotencyKey: `webhook-ledger:${eventId}`,
      metadata: { amountKrw, providerPaymentId, source: 'mockpay-webhook' },
    });

    await prisma.paymentWebhookEvent.update({
      where: { id: event.id },
      data: { processed: true, processedAt: new Date() },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '웹훅 처리 중 오류가 발생했습니다.';
    const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: unknown }).status) || 500 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
