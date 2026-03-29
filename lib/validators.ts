import { z } from 'zod';

export const createProjectSchema = z.object({
  title: z.string().min(1),
  subject: z.string().optional().default(''),
  description: z.string().optional().default(''),
});

export const generateSchema = z.object({
  projectId: z.string().optional().default(''),
  notionPageId: z.string().optional(),
  customNotes: z.string().optional(),
  noteText: z.string().optional().default(''),
  mode: z.enum(['notes', 'quiz']).optional().default('notes'),
  rangeStart: z.string().optional().default(''),
  rangeEnd: z.string().optional().default(''),
  redirectTo: z.string().optional().default('/'),
});

export const messageSchema = z.object({
  projectId: z.string().optional().default(''),
  text: z.string().min(1),
  redirectTo: z.string().optional().default('/'),
});

export const chargeCreateSchema = z.object({
  amountKrw: z.coerce.number().int().positive(),
  creditAmount: z.coerce.number().int().positive(),
  provider: z.string().min(1).default('mockpay'),
  idempotencyKey: z.string().min(8),
});

export const autoRechargeSettingSchema = z.object({
  enabled: z.coerce.boolean(),
  threshold: z.coerce.number().int().nonnegative().default(1000),
  rechargeAmountKrw: z.coerce.number().int().positive().default(10000),
  rechargeCreditAmount: z.coerce.number().int().positive().default(10000),
  paymentMethodRef: z.string().optional().default(''),
});
