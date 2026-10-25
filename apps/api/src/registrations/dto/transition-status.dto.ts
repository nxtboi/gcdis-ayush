import { IsNotEmpty, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { RegistrationStatus } from '@gcdis/shared';

export class TransitionStatusDto {
  @IsNotEmpty()
  @IsEnum(RegistrationStatus)
  targetStatus: RegistrationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'The reason must not exceed 500 characters.' })
  reason?: string;
}
