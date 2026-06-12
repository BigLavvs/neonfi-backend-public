import type { Chain } from '@prisma/client';

export interface ChainDTO {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  moralisId: string;
}

export function toChainDTO(chain: Chain): ChainDTO {
  return {
    id: chain.id,
    name: chain.name,
    slug: chain.slug,
    logoUrl: chain.logoUrl,
    moralisId: chain.moralisId,
  };
}
