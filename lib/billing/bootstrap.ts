import { prisma } from '@/lib/prisma';

let bootstrapped = false;

export async function ensureBillingBootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;

  const hasRule = await prisma.pricingRule.findFirst({
    where: { version: 'default-v1' },
    select: { id: true },
  });

  if (!hasRule) {
    await prisma.pricingRule.create({
      data: {
        version: 'default-v1',
        feature: 'annotated_notes_generation',
        model: null,
        chargeType: 'hybrid',
        fixedAmount: 120n,
        inputPer1k: 12n,
        outputPer1k: 24n,
        fileSurcharge: 80n,
        active: true,
      },
    });
  }
}

