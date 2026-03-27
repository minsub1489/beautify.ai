import { prisma } from '@/lib/prisma';

export type UsageMetrics = {
  feature: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  fileCount: number;
};

export type ResolvedPricing = {
  ruleVersion: string;
  chargeType: 'fixed' | 'token_based' | 'hybrid';
  fixedAmount: bigint;
  inputPer1k: bigint;
  outputPer1k: bigint;
  fileSurcharge: bigint;
};

const FALLBACK_RULE: ResolvedPricing = {
  ruleVersion: 'default-v1',
  chargeType: 'hybrid',
  fixedAmount: 120n,
  inputPer1k: 12n,
  outputPer1k: 24n,
  fileSurcharge: 80n,
};

export function estimateTokensFromText(text: string) {
  const chars = text.trim().length;
  if (!chars) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

export async function resolvePricingRule(feature: string, model?: string): Promise<ResolvedPricing> {
  const rule = await prisma.pricingRule.findFirst({
    where: {
      active: true,
      feature,
      OR: [{ model: model || null }, { model: null }],
    },
    orderBy: [{ model: 'desc' }, { createdAt: 'desc' }],
  });

  if (!rule) return FALLBACK_RULE;

  const chargeType = (rule.chargeType as ResolvedPricing['chargeType']) || 'hybrid';

  return {
    ruleVersion: rule.version,
    chargeType,
    fixedAmount: rule.fixedAmount ?? 0n,
    inputPer1k: rule.inputPer1k ?? 0n,
    outputPer1k: rule.outputPer1k ?? 0n,
    fileSurcharge: rule.fileSurcharge ?? 0n,
  };
}

export function computeUsageCharge(pricing: ResolvedPricing, usage: UsageMetrics) {
  const inUnits = BigInt(Math.ceil((usage.inputTokens || 0) / 1000));
  const outUnits = BigInt(Math.ceil((usage.outputTokens || 0) / 1000));
  const files = BigInt(Math.max(0, usage.fileCount || 0));

  const tokenCost = inUnits * pricing.inputPer1k + outUnits * pricing.outputPer1k;
  const fixed = pricing.chargeType === 'token_based' ? 0n : pricing.fixedAmount;
  const tokenPart = pricing.chargeType === 'fixed' ? 0n : tokenCost;

  return fixed + tokenPart + files * pricing.fileSurcharge;
}
