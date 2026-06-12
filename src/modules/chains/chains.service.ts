import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';
import { listAllChains } from './chains.repository.js';
import { toChainDTO, type ChainDTO } from './chains.dto.js';
import { FREE_TIER_CHAIN_SLUGS } from './chains.constants.js';

export async function getVisibleChains(userId: number): Promise<ChainDTO[]> {
  const [effectivePlan, allChains] = await Promise.all([
    getEffectivePlan(userId),
    listAllChains(),
  ]);
  const visible =
    effectivePlan === 'pro'
      ? allChains
      : allChains.filter((c) => FREE_TIER_CHAIN_SLUGS.includes(c.slug));
  return visible.map(toChainDTO);
}
