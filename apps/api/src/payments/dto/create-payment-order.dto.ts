import { IsNotEmpty, IsString, IsOptional, IsEnum } from 'class-validator';
import { PaymentGateway } from '@gcdis/shared';

export class CreatePaymentOrderDto {
  @IsNotEmpty()
  @IsString()
  registrationId: string;

  @IsOptional()
  @IsEnum(PaymentGateway)
  gateway?: PaymentGateway;
}

export class VerifyPaymentSignatureDto {
  @IsNotEmpty()
  @IsString()
  razorpayOrderId: string;

  @IsNotEmpty()
  @IsString()
  razorpayPaymentId: string;

  @IsNotEmpty()
  @IsString()
  razorpaySignature: string;
}
