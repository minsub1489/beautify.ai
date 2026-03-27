import { prisma } from '@/lib/prisma';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { maybeAutoRecharge } from '@/lib/billing/auto-recharge';
import { computeUsageCharge, estimateTokensFromText, resolvePricingRule } from '@/lib/billing/pricing';
import { Prisma } from '@prisma/client';

type BeginAiUsageInput = {
  userId: string;
  feature: string;
  model: string;
  inputText: string;
  fileCount: number;
  requestMetadata?: Record<string, unknown>;
};

type FinalizeAiUsageInput = {
  requestId: string;
  outputText: string;
  metadata?: Record<string, unknown>;
};

type FailAiUsageInput = {
  requestId: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
};

const HOLD_MINIMUM_CREDITS = BigInt(process.env.BILLING_HOLD_MIN_CREDITS || '300');

export async function beginAiUsage(input: BeginAiUsageInput) {
  const pricing = await resolvePricingRule(input.feature, input.model);
  const estimatedInputTokens = estimateTokensFromText(input.inputText);
  const estimatedCost = computeUsageCharge(pricing, {
    feature: input.feature,
    model: input.model,
    inputTokens: estimatedInputTokens,
    outputTokens: Math.max(128, Math.ceil(estimatedInputTokens * 0.35)),
    fileCount: input.fileCount,
  });
  const holdAmount = estimatedCost > HOLD_MINIMUM_CREDITS ? estimatedCost : HOLD_MINIMUM_CREDITS;

  const request = await prisma.aiUsageRequest.create({
    data: {
      userId: input.userId,
      status: 'running',
      model: input.model,
      feature: input.feature,
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      fileCount: input.fileCount,
      estimatedCost,
      actualCost: 0n,
      pricingRuleVersion: pricing.ruleVersion,
      metadata: (input.requestMetadata ?? {}) as Prisma.InputJsonValue,
    },
  });

  await maybeAutoRecharge({
    userId: input.userId,
    reasonRequestId: request.id,
  });

  await applyLedgerEntry({
    userId: input.userId,
    type: 'hold',
    amount: -holdAmount,
    requestId: request.id,
    reason: 'AI 사용 예약 차감',
    idempotencyKey: `hold:${request.id}`,
    metadata: {
      estimatedCost: estimatedCost.toString(),
      holdAmount: holdAmount.toString(),
      ruleVersion: pricing.ruleVersion,
      model: input.model,
      feature: input.feature,
    },
  });

  return {
    requestId: request.id,
    holdAmount,
    estimatedCost,
    pricingRuleVersion: pricing.ruleVersion,
  };
}

export async function finalizeAiUsage(input: FinalizeAiUsageInput) {
  const request = await prisma.aiUsageRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) return;

  const pricing = await resolvePricingRule(request.feature, request.model);
  const outputTokens = estimateTokensFromText(input.outputText);
  const actualCost = computeUsageCharge(pricing, {
    feature: request.feature,
    model: request.model,
    inputTokens: request.inputTokens,
    outputTokens,
    fileCount: request.fileCount,
  });

  const holdAmount = request.estimatedCost > HOLD_MINIMUM_CREDITS ? request.estimatedCost : HOLD_MINIMUM_CREDITS;
  const releaseAmount = holdAmount - actualCost;

  if (releaseAmount >= 0n) {
    await applyLedgerEntry({
      userId: request.userId,
      type: 'capture',
      amount: 0n,
      requestId: request.id,
      reason: 'AI 사용 확정',
      idempotencyKey: `capture:${request.id}`,
      metadata: {
        actualCost: actualCost.toString(),
        outputTokens,
      },
    });

    if (releaseAmount > 0n) {
      await applyLedgerEntry({
        userId: request.userId,
        type: 'release',
        amount: releaseAmount,
        requestId: request.id,
        reason: '예약 차감 잔액 복구',
        idempotencyKey: `release:${request.id}`,
        metadata: { holdAmount: holdAmount.toString(), actualCost: actualCost.toString() },
      });
    }
  } else {
    await maybeAutoRecharge({
      userId: request.userId,
      reasonRequestId: request.id,
    });

    await applyLedgerEntry({
      userId: request.userId,
      type: 'usage',
      amount: releaseAmount,
      requestId: request.id,
      reason: '예약 차감 초과분 추가 차감',
      idempotencyKey: `overage:${request.id}`,
      metadata: {
        holdAmount: holdAmount.toString(),
        actualCost: actualCost.toString(),
      },
    });
  }

  await prisma.aiUsageRequest.update({
    where: { id: request.id },
    data: {
      status: 'succeeded',
      outputTokens,
      actualCost,
      completedAt: new Date(),
      metadata: {
        ...(request.metadata && typeof request.metadata === 'object' ? request.metadata : {}),
        ...(input.metadata || {}),
      } as Prisma.InputJsonValue,
    },
  });
}

export async function failAiUsage(input: FailAiUsageInput) {
  const request = await prisma.aiUsageRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) return;

  const holdAmount = request.estimatedCost > HOLD_MINIMUM_CREDITS ? request.estimatedCost : HOLD_MINIMUM_CREDITS;
  await applyLedgerEntry({
    userId: request.userId,
    type: 'recovery',
    amount: holdAmount,
    requestId: request.id,
    reason: 'AI 실패 복구',
    idempotencyKey: `recovery:${request.id}`,
    metadata: {
      errorCode: input.errorCode || 'FAILED',
      ...input.metadata,
    },
  });

  await prisma.aiUsageRequest.update({
    where: { id: request.id },
    data: {
      status: 'failed',
      errorCode: input.errorCode || 'FAILED',
      completedAt: new Date(),
      metadata: {
        ...(request.metadata && typeof request.metadata === 'object' ? request.metadata : {}),
        ...(input.metadata || {}),
      } as Prisma.InputJsonValue,
    },
  });
}
