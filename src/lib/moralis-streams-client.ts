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

// retrofit-58 Part 3: the "Create Stream" verb is **PUT** /streams/evm, not POST — the old
// POST returned 404 "Cannot POST /streams/evm", so moralisStreamId was always null and
// connected wallets never received live webhook updates (same class as the retrofit-54 NFT
// path bug). Probe-confirmed against the live API (retrofit-58): the body field is `chainIds`
// (not `chains`), and the empty `abi`/`topic0`/`advancedOptions`/`getNativeBalances` arrays the
// old body sent each trip 400 validation ("topic0 is required if abi is provided", etc.) —
// drop them; a native-tx watch needs none. The only remaining gate is webhook reachability:
// Moralis sends a test ping to webhookUrl and rejects unreachable URLs (prod API_BASE_URL is
// real, so this only bites in local probing).
export async function createStream(opts: CreateStreamOpts): Promise<{ id: string }> {
  const body = {
    webhookUrl: opts.webhookUrl,
    description: opts.description,
    tag: 'neonfi',
    chainIds: [opts.chainId],
    includeNativeTxs: true,
    includeContractLogs: false,
    allAddresses: false,
    includeInternalTxs: false,
  };

  const res = await fetch(MORALIS_STREAMS_BASE, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.MORALIS_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // audit SEC #11: keep the upstream body to the server logs only — never let it ride out
    // on the thrown Error (which can surface to the client via the 500 handler when
    // DEBUG_ERRORS is on). Throw a fixed internal message instead.
    const text = await res.text().catch(() => '');
    console.error('[moralis-streams] create failed', { status: res.status, body: text });
    throw new Error(`Moralis Streams create failed: ${res.status}`);
  }

  const data = await res.json() as { id: string };

  // Add wallet address to the stream. audit perf #51: this had no !res.ok check, so a failed
  // add-address silently returned a stream id watching NO address (no webhooks would ever
  // arrive). Surface it — the caller logs + continues, and a resync can re-create the stream.
  const addRes = await fetch(`${MORALIS_STREAMS_BASE}/${data.id}/address`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.MORALIS_API_KEY,
    },
    body: JSON.stringify({ address: opts.address }),
  });
  if (!addRes.ok) {
    const text = await addRes.text().catch(() => '');
    console.error('[moralis-streams] add-address failed', { streamId: data.id, status: addRes.status, body: text });
    throw new Error(`Moralis Streams add-address failed: ${addRes.status}`);
  }

  return { id: data.id };
}

export async function deleteStream(streamId: string): Promise<void> {
  const res = await fetch(`${MORALIS_STREAMS_BASE}/${streamId}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': config.MORALIS_API_KEY },
  });

  if (!res.ok) {
    // audit SEC #11: upstream body to server logs only; throw a fixed internal message.
    const text = await res.text().catch(() => '');
    console.error('[moralis-streams] delete failed', { status: res.status, body: text });
    throw new Error(`Moralis Streams delete failed: ${res.status}`);
  }
}
