import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUserId } from '@/lib/auth-user';
import { assertWithinRateLimit } from '@/lib/rate-limit';

export async function GET(req: Request) {
  try {
    const userId = await getCurrentUserId();
    assertWithinRateLimit(userId, 'billing-ledger');
    const url = new URL(req.url);
    const take = Math.min(100, Math.max(1, Number(url.searchParams.get('take') || '30')));
    const cursor = url.searchParams.get('cursor') || '';

    const rows = await prisma.creditLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take,
    });

    return NextResponse.json({
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        amount: row.amount.toString(),
        balanceBefore: row.balanceBefore.toString(),
        balanceAfter: row.balanceAfter.toString(),
        reason: row.reason || '',
        requestId: row.requestId || '',
        paymentOrderId: row.paymentOrderId || '',
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length === take ? rows[rows.length - 1].id : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '원장 조회 중 오류가 발생했습니다.';
    const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: unknown }).status) || 500 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

