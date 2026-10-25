import { BadRequestException } from '@nestjs/common';
import type { ZodTypeAny, infer as ZodInfer } from 'zod';

/**
 * Parses an untrusted request body with a zod schema.
 * Invalid input always yields 400 (never a 500 from downstream code).
 * Unknown keys are stripped (zod object default), so only whitelisted fields reach services/Prisma.
 */
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): ZodInfer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message
    }));
    throw new BadRequestException({
      error: 'VALIDATION_FAILED',
      message: details.map((d) => `${d.field}: ${d.message}`).join('; '),
      details
    });
  }
  return result.data;
}
