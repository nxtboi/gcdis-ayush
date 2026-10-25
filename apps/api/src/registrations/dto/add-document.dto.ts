import { IsNotEmpty, IsEnum, IsString, IsOptional, MaxLength } from 'class-validator';
import { DocumentType } from '@gcdis/shared';

export class AddDocumentDto {
  @IsNotEmpty()
  @IsEnum(DocumentType)
  type: DocumentType;

  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  assetId: string;

  /** Display name of the file (the stored file is identified by assetId). */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}
