import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  ValidationOptions,
  buildMessage,
  isURL
} from 'class-validator';
import { SPONSOR_PLACEMENTS, SPONSOR_TIERS } from '../site-content.defaults';

/** Public path of a stored upload, e.g. /api/uploads/files/<uuid>_<hex>.png */
export const UPLOAD_PATH_PATTERN = /^\/api\/uploads\/files\/[A-Za-z0-9_.-]{1,200}$/;

export function isHttpsUrl(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    isURL(value, { protocols: ['https'], require_protocol: true, require_valid_protocol: true, require_tld: true, allow_underscores: true })
  );
}

/** An absolute https URL. */
export function IsHttpsUrl(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isHttpsUrl',
      validator: {
        validate: (value) => isHttpsUrl(value),
        defaultMessage: buildMessage((each) => `${each}$property must be an https URL`, options)
      }
    },
    options
  );
}

/** An uploaded file path (/api/uploads/files/...) or an absolute https URL. */
export function IsImageRef(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isImageRef',
      validator: {
        validate: (value) => (typeof value === 'string' && UPLOAD_PATH_PATTERN.test(value)) || isHttpsUrl(value),
        defaultMessage: buildMessage(
          (each) => `${each}$property must be an uploaded file path (/api/uploads/files/...) or an https URL`,
          options
        )
      }
    },
    options
  );
}

/** An uploaded file path only (/api/uploads/files/...). */
export function IsUploadPath(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isUploadPath',
      validator: {
        validate: (value) => typeof value === 'string' && UPLOAD_PATH_PATTERN.test(value),
        defaultMessage: buildMessage((each) => `${each}$property must be an uploaded file path (/api/uploads/files/...)`, options)
      }
    },
    options
  );
}

const trim = ({ value }: { value: any }) => (typeof value === 'string' ? value.trim() : value);
/** Optional nullable text/URL: trims and turns '' into null (clears the field). */
const trimOrNull = ({ value }: { value: any }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
};

// ---------------------------------------------------------------- Sponsors

export class CreateSponsorDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsIn(SPONSOR_TIERS as unknown as string[])
  tier!: string;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(2048)
  @IsImageRef()
  logoUrl?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(2048)
  @IsHttpsUrl()
  websiteUrl?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(SPONSOR_PLACEMENTS as unknown as string[], { each: true })
  placements!: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  displayOrder?: number;
}

export class UpdateSponsorDto {
  @ValidateIf((o) => o.name !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ValidateIf((o) => o.tier !== undefined)
  @IsIn(SPONSOR_TIERS as unknown as string[])
  tier?: string;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(2048)
  @IsImageRef()
  logoUrl?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(2048)
  @IsHttpsUrl()
  websiteUrl?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ValidateIf((o) => o.placements !== undefined)
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(SPONSOR_PLACEMENTS as unknown as string[], { each: true })
  placements?: string[];

  @ValidateIf((o) => o.isActive !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ValidateIf((o) => o.displayOrder !== undefined)
  @IsInt()
  @Min(0)
  @Max(100000)
  displayOrder?: number;
}

/** PUT .../order: the new order (first id = position 0). */
export class ReorderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}

// ---------------------------------------------------------------- Gallery

export class CreateGalleryImageDto {
  @Transform(trim)
  @IsString()
  @MaxLength(2048)
  @IsUploadPath()
  imageUrl!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  title!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  altText!: string;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(1000)
  caption?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(60)
  category?: string | null;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateGalleryImageDto {
  @ValidateIf((o) => o.imageUrl !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(2048)
  @IsUploadPath()
  imageUrl?: string;

  @ValidateIf((o) => o.title !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  title?: string;

  @ValidateIf((o) => o.altText !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  altText?: string;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(1000)
  caption?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(60)
  category?: string | null;

  @ValidateIf((o) => o.isPublished !== undefined)
  @IsBoolean()
  isPublished?: boolean;
}

// ---------------------------------------------------------------- Settings

export class SitePhoneDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  display!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^\+?[0-9]{6,15}$/, { message: 'tel must be 6 to 15 digits, optionally starting with +' })
  tel!: string;
}

export class SiteSocialDto {
  @IsOptional()
  @Transform(trimOrNull)
  @IsHttpsUrl()
  linkedin?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsHttpsUrl()
  instagram?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsHttpsUrl()
  youtube?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsHttpsUrl()
  x?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsHttpsUrl()
  facebook?: string | null;
}

export class SiteInfoDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  organisationName!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  shortName!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  universityName!: string;

  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  addressLines!: string[];

  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => SitePhoneDto)
  phones!: SitePhoneDto[];

  @Transform(trim)
  @IsString()
  @MaxLength(254)
  @IsEmail()
  email!: string;

  @IsOptional()
  @Transform(trimOrNull)
  @IsHttpsUrl()
  mapUrl?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => SiteSocialDto)
  social?: SiteSocialDto;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(2048)
  @IsImageRef()
  aboutImageUrl?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(300)
  aboutImageAlt?: string | null;
}

export class SponsorsShowOnDto {
  @IsBoolean()
  home!: boolean;

  @IsBoolean()
  event!: boolean;

  @IsBoolean()
  footer!: boolean;
}

export class SponsorsSectionDto {
  @IsBoolean()
  enabled!: boolean;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @Transform(({ value }) => (value === null ? '' : typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(300)
  subtitle?: string;

  @ValidateNested()
  @Type(() => SponsorsShowOnDto)
  showOn!: SponsorsShowOnDto;
}

export class GallerySectionDto {
  @IsBoolean()
  enabled!: boolean;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @Transform(({ value }) => (value === null ? '' : typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(300)
  subtitle?: string;
}
