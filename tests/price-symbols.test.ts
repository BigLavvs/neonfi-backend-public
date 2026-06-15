// Neonfi backend — cross-exchange symbol normalization tests (retrofit-16).
//
// Pure unit tests: no sockets, no Redis, no DB. The catalog working set is
// injected directly via setCatalogSymbols() so membership/coverage can be
// exercised without touching Prisma/Neon.

import { it, expect, describe } from 'vitest';
import {
  fromBinanceSymbol,
  toBinanceBase,
  fromKrakenName,
  toKrakenPair,
  PREFERRED_BINANCE_QUOTES,
  setCatalogSymbols,
  isCatalogSymbol,
  getCatalogSymbols,
  getKrakenCoverage,
} from '../src/lib/price-symbols.js';

describe('binance symbol normalization', () => {
  it('BTCUSDT → {BTC, USDT}', () => {
    expect(fromBinanceSymbol('BTCUSDT')).toEqual({ base: 'BTC', quote: 'USDT' });
  });

  it('ETHUSDC → {ETH, USDC}', () => {
    expect(fromBinanceSymbol('ETHUSDC')).toEqual({ base: 'ETH', quote: 'USDC' });
  });

  it('BTCFDUSD → {BTC, FDUSD}', () => {
    expect(fromBinanceSymbol('BTCFDUSD')).toEqual({ base: 'BTC', quote: 'FDUSD' });
  });

  it('non-USD-stable quote (BTCEUR) → null', () => {
    expect(fromBinanceSymbol('BTCEUR')).toBeNull();
  });

  it('crypto-quoted pair (ETHBTC) → null', () => {
    expect(fromBinanceSymbol('ETHBTC')).toBeNull();
  });

  it('lowercase input is normalized', () => {
    expect(fromBinanceSymbol('solusdt')).toEqual({ base: 'SOL', quote: 'USDT' });
  });

  it('toBinanceBase uppercases and round-trips', () => {
    expect(toBinanceBase('btc')).toBe('BTC');
    expect(fromBinanceSymbol(`${toBinanceBase('sol')}USDT`)).toEqual({ base: 'SOL', quote: 'USDT' });
  });

  it('PREFERRED_BINANCE_QUOTES order is USDT → USDC → FDUSD', () => {
    expect([...PREFERRED_BINANCE_QUOTES]).toEqual(['USDT', 'USDC', 'FDUSD']);
  });
});

describe('kraken pair normalization', () => {
  it('BTC/USD → {BTC, USD}', () => {
    expect(fromKrakenName('BTC/USD')).toEqual({ base: 'BTC', quote: 'USD' });
  });

  it('XBT/USD → {BTC, USD} (legacy XBT→BTC quirk)', () => {
    expect(fromKrakenName('XBT/USD')).toEqual({ base: 'BTC', quote: 'USD' });
  });

  it('XDG/USD → {DOGE, USD} (legacy XDG→DOGE quirk)', () => {
    expect(fromKrakenName('XDG/USD')).toEqual({ base: 'DOGE', quote: 'USD' });
  });

  it('toKrakenPair BTC → BTC/USD', () => {
    expect(toKrakenPair('BTC')).toBe('BTC/USD');
    expect(toKrakenPair('eth')).toBe('ETH/USD');
  });

  it('malformed name (no slash) → null', () => {
    expect(fromKrakenName('BTCUSD')).toBeNull();
  });
});

describe('catalog working set', () => {
  it('setCatalogSymbols / isCatalogSymbol / getCatalogSymbols', () => {
    setCatalogSymbols(['BTC', 'eth', 'SOL']);
    expect(isCatalogSymbol('btc')).toBe(true);
    expect(isCatalogSymbol('ETH')).toBe(true);
    expect(isCatalogSymbol('DOGE')).toBe(false);
    expect(getCatalogSymbols().has('SOL')).toBe(true);
  });

  it('getKrakenCoverage takes the top-N by insertion (rank) order as SYM/USD', () => {
    setCatalogSymbols(['BTC', 'ETH', 'SOL', 'XRP']);
    expect(getKrakenCoverage(2)).toEqual(['BTC/USD', 'ETH/USD']);
    expect(getKrakenCoverage()).toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD']);
  });

  it('accepts a Set as well as an array', () => {
    setCatalogSymbols(new Set(['ada']));
    expect(isCatalogSymbol('ADA')).toBe(true);
  });
});
