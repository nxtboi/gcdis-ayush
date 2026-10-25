import { IsNotEmpty, IsString, IsObject, IsOptional, IsArray } from 'class-validator';

export class SubmitInspectionDto {
  @IsNotEmpty()
  @IsString()
  registrationId: string;

  @IsNotEmpty()
  @IsObject()
  checks: Record<string, { passed: boolean; value?: any; note?: string }>;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  photos?: string[];
}
