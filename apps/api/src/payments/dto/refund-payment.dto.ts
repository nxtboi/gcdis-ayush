import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Upper bound for a refund reason (stored on the payment, sent to the gateway and audited). */
export const REFUND_REASON_MAX_LENGTH = 500;

export class RefundPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(REFUND_REASON_MAX_LENGTH, {
    message: `The refund reason must not exceed ${REFUND_REASON_MAX_LENGTH} characters.`
  })
  reason?: string;
}
