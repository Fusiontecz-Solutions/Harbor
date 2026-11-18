import type { Request } from 'express';

export interface PaginationParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/**
 * Reads `page` and `pageSize` (or `limit`) from the query string, clamped to
 * sane bounds. Returns null when the caller sent neither and `defaultPageSize`
 * is null, so an endpoint can keep its old "return everything" behaviour for
 * clients that never asked for pages.
 */
export function parsePagination(
  req: Request,
  opts: { defaultPageSize?: number | null; maxPageSize?: number } = {},
): PaginationParams | null {
  const { defaultPageSize = 25, maxPageSize = 500 } = opts;
  const rawSize = req.query.pageSize ?? req.query.limit;
  const asked = req.query.page != null || rawSize != null;
  if (!asked && defaultPageSize == null) return null;

  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Math.floor(Number(rawSize)) || defaultPageSize || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** The `pagination` block the list endpoints return. */
export function paginationMeta(p: PaginationParams, total: number) {
  return {
    page: p.page,
    pageSize: p.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
    hasMore: p.page * p.pageSize < total,
  };
}
