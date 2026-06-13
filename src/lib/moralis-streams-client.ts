// Neonfi backend — Moralis Streams REST API client (Stage 12, §6.1).
//
// Creates and deletes Moralis Streams (EVM) so connected portfolios receive
// webhook events. Called from portfolios.service.ts on create/delete.
//
// On create failure: caller logs and continues — portfolio creation still succeeds.
// On delete failure: caller logs and continues — portfolio deletion still proceeds.
// No retry-with-backoff per §8.

import { config } from './config.js';

const MORALIS_STREAMS_BASE = 'https://api.moralis-streams.com/streams/evm';

export interface CreateStreamOpts {
  webhookUrl: string;
  chainId: string;   // Moralis chain ID (e.g. '0x1')
  address: string;   // wallet address to watch
  description: string;
}

export async function createStream(opts: CreateStreamOpts): Promise<{ id: string }> {
  const body = {
    webhookUrl: opts.webhookUrl,
    description: opts.description,
    tag: 'neonfi',
    chains: [opts.chainId],
    includeNativeTxs: true,
    includeContractLogs: false,
    abi: [],
    advancedOptions: [],
    topic0: [],
    allAddresses: false,
    includeInternalTxs: false,
    getNativeBalances: [],
  };

  const res = await fetch(MORALIS_STREAMS_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.MORALIS_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Moralis Streams create failed: ${res.status} ${text}`);
  }

  const data = await res.json() as { id: string };

  // Add wallet address to the stream
  await fetch(`${MORALIS_STREAMS_BASE}/${data.id}/address`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.MORALIS_API_KEY,
    },
    body: JSON.stringify({ address: opts.address }),
  });

  return { id: data.id };
}

export async function deleteStream(streamId: string): Promise<void> {
  const res = await fetch(`${MORALIS_STREAMS_BASE}/${streamId}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': config.MORALIS_API_KEY },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Moralis Streams delete failed: ${res.status} ${text}`);
  }
}
