import { prisma } from '../../lib/prisma.js';
import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';
import { FREE_TIER_CHAIN_SLUGS } from '../chains/chains.constants.js';
import {
  findPortfolioById,
  findPortfoliosByUserId,
  countPortfoliosByUserId,
  findUserPortfolioNames,
  createPortfolioRow,
  updatePortfolioName,
  deletePortfolio,
} from './portfolios.repository.js';
import { toPortfolioDTO, type PortfolioDTO } from './portfolios.dto.js';
import { slugify } from './slug.js';
import { validateWalletAddress } from './wallet-validator.js';
import type { CreatePortfolioBody, ListPortfoliosQuery, UpdatePortfolioBody } from './portfolios.schemas.js';

const PLAN_CAPS: Record<'free' | 'pro', number> = { free: 1, pro: 10 };

export class PortfolioError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PortfolioError';
  }
}

async function assertSlugAvailable(
  userId: number,
  name: string,
  excludeId?: number,
): Promise<void> {
  const newSlug = slugify(name);
  if (!newSlug) {
    throw new PortfolioError(400, 'INVALID_NAME', 'Portfolio name produces an empty slug');
  }
  const existing = await findUserPortfolioNames(userId);
  for (const p of existing) {
    if (excludeId !== undefined && p.id === excludeId) continue;
    if (slugify(p.name) === newSlug) {
      throw new PortfolioError(409, 'NAME_TAKEN', 'A portfolio with that name already exists');
    }
  }
}

export async function createPortfolio(
  userId: number,
  body: CreatePortfolioBody,
): Promise<PortfolioDTO> {
  const effectivePlan = await getEffectivePlan(userId);
  const cap = PLAN_CAPS[effectivePlan];
  const count = await countPortfoliosByUserId(userId);
  if (count >= cap) {
    throw new PortfolioError(403, 'PLAN_LIMIT_REACHED', 'Portfolio limit reached for your plan', {
      current: count,
      limit: cap,
      plan: effectivePlan,
    });
  }

  await assertSlugAvailable(userId, body.name);

  const portfolioType = await prisma.portfolioType.findUniqueOrThrow({
    where: { name: body.type },
  });

  if (body.type === 'connected') {
    const chain = await prisma.chain.findUnique({ where: { id: body.chainId } });
    if (!chain) {
      throw new PortfolioError(400, 'INVALID_CHAIN', 'Chain not found');
    }
    if (effectivePlan === 'free' && !FREE_TIER_CHAIN_SLUGS.includes(chain.slug)) {
      throw new PortfolioError(
        403,
        'PLAN_LIMIT_REACHED',
        'This chain requires a Pro subscription',
        { chainSlug: chain.slug, plan: 'free' },
      );
    }
    const validation = validateWalletAddress(body.walletAddress, chain);
    if (!validation.valid) {
      throw new PortfolioError(
        400,
        'INVALID_WALLET_ADDRESS',
        'Invalid wallet address for this chain',
        { chainSlug: chain.slug },
      );
    }
    // TODO(Stage 11): Moralis webhook will sync assets/transactions after this row is created.
    const portfolio = await createPortfolioRow({
      userId,
      name: body.name,
      typeId: portfolioType.id,
      walletAddress: validation.normalized!,
      chainId: chain.id,
    });
    return toPortfolioDTO(portfolio);
  }

  // type === 'manual'
  const portfolio = await createPortfolioRow({
    userId,
    name: body.name,
    typeId: portfolioType.id,
    startingBalance: body.startingBalance,
  });
  return toPortfolioDTO(portfolio);
}

export async function listPortfolios(
  userId: number,
  query: ListPortfoliosQuery,
): Promise<{ portfolios: PortfolioDTO[]; meta: { limit: number; offset: number; total: number } }> {
  const { portfolios, total } = await findPortfoliosByUserId(userId, {
    limit: query.limit,
    offset: query.offset,
  });
  return {
    portfolios: portfolios.map(toPortfolioDTO),
    meta: { limit: query.limit, offset: query.offset, total },
  };
}

export async function getPortfolio(userId: number, id: number): Promise<PortfolioDTO> {
  const portfolio = await findPortfolioById(id);
  if (!portfolio || portfolio.userId !== userId) {
    throw new PortfolioError(403, 'FORBIDDEN', 'Forbidden');
  }
  return toPortfolioDTO(portfolio);
}

export async function updatePortfolio(
  userId: number,
  id: number,
  body: UpdatePortfolioBody,
): Promise<PortfolioDTO> {
  const portfolio = await findPortfolioById(id);
  if (!portfolio || portfolio.userId !== userId) {
    throw new PortfolioError(403, 'FORBIDDEN', 'Forbidden');
  }
  if (body.name === portfolio.name) {
    return toPortfolioDTO(portfolio);
  }
  await assertSlugAvailable(userId, body.name, id);
  const updated = await updatePortfolioName(id, body.name);
  return toPortfolioDTO(updated);
}

export async function deletePortfolioById(userId: number, id: number): Promise<void> {
  const portfolio = await findPortfolioById(id);
  if (!portfolio || portfolio.userId !== userId) {
    throw new PortfolioError(403, 'FORBIDDEN', 'Forbidden');
  }
  await deletePortfolio(id);
}
