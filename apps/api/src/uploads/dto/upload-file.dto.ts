import { IsNotEmpty, IsString, IsOptional, IsIn } from 'class-validator';
import { UPLOAD_PURPOSES, UploadPurpose } from '../uploads.service';

export class UploadFileDto {
  @IsNotEmpty()
  @IsString()
  fileName: string;

  @IsNotEmpty()
  @IsString()
  base64Data: string;

  /** Strict whitelist of upload purposes; unknown values are refused with 400. */
  @IsOptional()
  @IsIn(UPLOAD_PURPOSES as unknown as string[], {
    message: `purpose must be one of: ${UPLOAD_PURPOSES.join(', ')}`
  })
  purpose?: UploadPurpose;
}
