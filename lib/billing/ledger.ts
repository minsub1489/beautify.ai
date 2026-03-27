import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';

export type LedgerEntryType =
  | 'charge'
  | 'usage'
  | 'refund'
  | 'recovery'
  | 'auto_recharge'
  | 'hold'
  | 'capture'
  | 'release';

type ApplyLedgerInput = {
  userId: string;
  type: LedgerEntryType;
  amount: bigint;
  idempotencyKey: string;
  reason?: string;
  requestId?: string;
  paymentOrderId?: string;
  metadata?: Record<string, unknown>;
};

type EnsureAccountOptions = {
  userId: string;
};

export async function ensureCreditAccount(options: EnsureAccountOptions) {
  const existing = await prisma.creditAccount.findUnique({
    where: { userId: options.userId },
  });
  if (existing) return existing;

  return prisma.creditAccount.create({
    data: {
      userId: options.userId,
      balance: 0n,
      currency: 'CREDIT',
      version: 0,
    },
  });
}

export async function applyLedgerEntry(input: ApplyLedgerInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.creditLedger.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return existing;
    }

    const existingAccount = await tx.creditAccount.findUnique({
      where: { userId: input.userId },
    });

    const account = existingAccount
      ? await tx.creditAccount.findUniqueOrThrow({
          where: { userId: input.userId },
        })
      : await tx.creditAccount.create({
          data: {
            userId: input.userId,
            balance: 0n,
            currency: 'CREDIT',
            version: 0,
          },
        });

    const locked = await tx.$queryRaw<Array<{ balance: bigint }>>`
      SELECT balance
      FROM "CreditAccount"
      WHERE "userId" = ${input.userId}
      FOR UPDATE
    `;

    const currentBalance = locked[0]?.balance ?? account.balance;
    const nextBalance = currentBalance + input.amount;
    if (nextBalance < 0n) {
      const error = new Error('INSUFFICIENT_CREDIT') as Error & { status?: number };
      error.status = 402;
      throw error;
    }

    await tx.creditAccount.update({
      where: { userId: input.userId },
      data: {
        balance: nextBalance,
        version: { increment: 1 },
      },
    });

    return tx.creditLedger.create({
      data: {
        userId: input.userId,
        type: input.type,
        amount: input.amount,
        balanceBefore: currentBalance,
        balanceAfter: nextBalance,
        reason: input.reason,
        requestId: input.requestId,
        paymentOrderId: input.paymentOrderId,
        idempotencyKey: input.idempotencyKey,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  });
}

export async function getBalance(userId: string) {
  const account = await ensureCreditAccount({ userId });
  return account.balance;
}
