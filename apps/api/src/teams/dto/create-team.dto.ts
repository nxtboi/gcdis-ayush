import {
  IsNotEmpty,
  IsString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsArray,
  ValidateNested,
  ArrayMaxSize,
  Matches,
  MaxLength
} from 'class-validator';
import { Type } from 'class-transformer';
import { TeamMemberRole, FIDA_MAX_TEAM_SIZE } from '@gcdis/shared';

const ID_PROOF_URL_REGEX = /^\/api\/uploads\/files\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const ID_PROOF_URL_MESSAGE =
  'idProofUrl must be the relative /api/uploads/files/<key> URL returned by the upload endpoint';

/**
 * Member phone numbers: 7–20 characters of digits, with an optional leading + and spaces or hyphens.
 * An empty string is accepted (on update it clears the stored number).
 */
export const MEMBER_PHONE_REGEX = /^(?:\+?[0-9][0-9 -]{5,18}[0-9])?$/;
const MEMBER_PHONE_MESSAGE =
  'Please enter a valid mobile number (digits, optionally with a leading + and spaces or hyphens).';

export class TeamMemberDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  fullName: string;

  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(MEMBER_PHONE_REGEX, { message: MEMBER_PHONE_MESSAGE })
  phone?: string;

  @IsNotEmpty()
  @IsEnum(TeamMemberRole)
  memberRole: TeamMemberRole;

  @IsOptional()
  @IsString()
  @Matches(ID_PROOF_URL_REGEX, { message: ID_PROOF_URL_MESSAGE })
  idProofUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  tshirtSize?: string;
}

/** Partial member update (PATCH /teams/:id/members/:memberId). */
export class UpdateTeamMemberDto {
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(MEMBER_PHONE_REGEX, { message: MEMBER_PHONE_MESSAGE })
  phone?: string;

  @IsOptional()
  @IsEnum(TeamMemberRole)
  memberRole?: TeamMemberRole;

  @IsOptional()
  @IsString()
  @Matches(ID_PROOF_URL_REGEX, { message: ID_PROOF_URL_MESSAGE })
  idProofUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  tshirtSize?: string;
}

export class CreateTeamDto {
  @IsNotEmpty()
  @IsString()
  categoryId: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(80)
  teamName: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(160)
  institutionName: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(80)
  city: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  /**
   * Optional at registration: FIDA requires the full roster only before competition. The captain is
   * added automatically as a CAPTAIN member, so the total roster (including the captain) is limited
   * to FIDA_MAX_TEAM_SIZE (7) and to the category's maxTeamSize by the service.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FIDA_MAX_TEAM_SIZE)
  @ValidateNested({ each: true })
  @Type(() => TeamMemberDto)
  members?: TeamMemberDto[];
}
