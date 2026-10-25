import { IsNotEmpty, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DocumentStatus } from '@gcdis/shared';

/** Upper bound for reviewer feedback on a document (stored and shown to the team). */
export const DOCUMENT_FEEDBACK_MAX_LENGTH = 1000;

export class VerifyDocumentDto {
  @IsNotEmpty()
  @IsEnum(DocumentStatus)
  status: DocumentStatus;

  /** Required (non-blank) when rejecting: enforced in RegistrationsService.verifyDocument. */
  @IsOptional()
  @IsString()
  @MaxLength(DOCUMENT_FEEDBACK_MAX_LENGTH, {
    message: `The feedback must not exceed ${DOCUMENT_FEEDBACK_MAX_LENGTH} characters.`
  })
  feedback?: string;
}
