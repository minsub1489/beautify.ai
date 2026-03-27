import { prisma } from '@/lib/prisma';
import { applyLedgerEntry, getBalance } from '@/lib/billing/ledger';

const AUTO_RECHARGE_COOLDOWN_MS = Number(process.env.AUTO_RECHARGE_COOLDOWN_MS || '120000');

type MaybeAutoRechargeParams = {
  userId: string;
  reasonRequestId: string;
};

export async function maybeAutoRecharge(params: MaybeAutoRechargeParams) {
  const setting = await prisma.autoRechargeSetting.findUnique({
    where: { userId: params.userId },
  });

  if (!setting || !setting.enabled) return { triggered: false as const, message: 'disabled' };

  const balance = await getBalance(params.userId);
  if (balance > setting.threshold) return { triggered: false as const, message: 'enough_balance' };

  const now = Date.now();
  const lastAttempt = setting.lastAttemptAt?.getTime() || 0;
  if (now - lastAttempt < AUTO_RECHARGE_COOLDOWN_MS) {
    return { triggered: false as const, message: 'cooldown' };
  }

  await prisma.autoRechargeSetting.update({
    where: { userId: params.userId },
    data: { lastAttemptAt: new Date() },
  });

  const idempotencyKey = `auto-recharge:${params.userId}:${Math.floor(now / AUTO_RECHARGE_COOLDOWN_MS)}`;

  const order = await prisma.paymentOrder.upsert({
    where: { idempotencyKey },
    create: {
      userId: params.userId,
      provider: 'mockpay',
      status: 'paid',
      amountKrw: setting.rechargeAmountKrw,
      creditAmount: setting.rechargeCreditAmount,
      idempotencyKey,
      providerPaymentId: `mock-${now}`,
      paidAt: new Date(),
      metadata: { auto: true },
    },
    update: {},
  });

  await applyLedgerEntry({
    userId: params.userId,
    type: 'auto_recharge',
    amount: setting.rechargeCreditAmount,
    reason: '자동충전',
    paymentOrderId: order.id,
    requestId: params.reasonRequestId,
    idempotencyKey: `ledger:${idempotencyKey}`,
    metadata: {
      threshold: setting.threshold.toString(),
      rechargeAmountKrw: setting.rechargeAmountKrw.toString(),
      rechargeCreditAmount: setting.rechargeCreditAmount.toString(),
    },
  });

  return {
    triggered: true as const,
    chargedCredits: setting.rechargeCreditAmount,
  };
}

