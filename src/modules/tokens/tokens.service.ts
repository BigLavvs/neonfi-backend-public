import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';
import { findManyTokens, findTokenById } from './tokens.repository.js';
import { toTokenListDTO, toTokenDetailDTO, type TokenListDTO, type TokenDetailDTO } from './tokens.dto.js';
import type { ListTokensQuery } from './tokens.schemas.js';

export class TokenError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

export async function listTokens(
  userId: number,
  query: ListTokensQuery,
): Promise<{ tokens: TokenListDTO[]; meta: { limit: number; nextCursor: number | null } }> {
  const effectivePlan = await getEffectivePlan(userId);
  const freeTier = effectivePlan !== 'pro';
  const cursor = query.cursor ?? null;

  const rows = await findManyTokens({ cursor, limit: query.limit, search: query.search, freeTier });

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const nextCursor = hasMore ? (items[items.length - 1]!.id) : null;

  return {
    tokens: items.map(toTokenListDTO),
    meta: { limit: query.limit, nextCursor },
  };
}

export async function getTokenById(id: number): Promise<TokenDetailDTO> {
  const token = await findTokenById(id);
  if (!token) {
    throw new TokenError(404, 'TOKEN_NOT_FOUND', 'Token not found');
  }
  return toTokenDetailDTO(token);
}
