import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  /** 1-based page number; used only when `offset` is not supplied (skip = (page - 1) * limit). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

/**
 * Converts (possibly unvalidated) limit/offset values into safe Prisma take/skip values.
 * Non-numeric or out-of-range values are clamped instead of reaching the database.
 */
export function toPrismaPagination(
  query?: { limit?: unknown; offset?: unknown; page?: unknown },
  defaultLimit: number = DEFAULT_PAGE_SIZE,
  maxLimit: number = MAX_PAGE_SIZE
): { take: number; skip: number } {
  const rawLimit = Number(query?.limit);
  const rawOffset = Number(query?.offset);
  const take = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), maxLimit) : Math.min(defaultLimit, maxLimit);
  const rawPage = Number(query?.page);
  const hasOffset = query?.offset !== undefined && query?.offset !== null && query?.offset !== '';
  let skip = 0;
  if (hasOffset) {
    skip = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
  } else if (Number.isFinite(rawPage) && rawPage >= 1) {
    skip = (Math.floor(rawPage) - 1) * take;
  }
  return { take, skip };
}
