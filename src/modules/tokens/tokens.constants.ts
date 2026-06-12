export interface TokenSeed {
  name: string;
  symbol: string;
  rank: number;
  currentPrice: string;
  marketCap: string;
}

export const TOKENS: TokenSeed[] = [
  { name: 'Bitcoin',          symbol: 'BTC',   rank: 1,  currentPrice: '93000.00',     marketCap: '1850000000000.00' },
  { name: 'Ethereum',         symbol: 'ETH',   rank: 2,  currentPrice: '3200.00',      marketCap: '385000000000.00'  },
  { name: 'Tether',           symbol: 'USDT',  rank: 3,  currentPrice: '1.00',         marketCap: '120000000000.00'  },
  { name: 'BNB',              symbol: 'BNB',   rank: 4,  currentPrice: '610.00',       marketCap: '88000000000.00'   },
  { name: 'Solana',           symbol: 'SOL',   rank: 5,  currentPrice: '165.00',       marketCap: '77000000000.00'   },
  { name: 'USD Coin',         symbol: 'USDC',  rank: 6,  currentPrice: '1.00',         marketCap: '35000000000.00'   },
  { name: 'XRP',              symbol: 'XRP',   rank: 7,  currentPrice: '0.62',         marketCap: '34000000000.00'   },
  { name: 'Dogecoin',         symbol: 'DOGE',  rank: 8,  currentPrice: '0.38',         marketCap: '55000000000.00'   },
  { name: 'Toncoin',          symbol: 'TON',   rank: 9,  currentPrice: '5.20',         marketCap: '13000000000.00'   },
  { name: 'Cardano',          symbol: 'ADA',   rank: 10, currentPrice: '0.45',         marketCap: '16000000000.00'   },
  { name: 'Avalanche',        symbol: 'AVAX',  rank: 11, currentPrice: '38.20',        marketCap: '15000000000.00'   },
  { name: 'TRON',             symbol: 'TRX',   rank: 12, currentPrice: '0.16',         marketCap: '14000000000.00'   },
  { name: 'Shiba Inu',        symbol: 'SHIB',  rank: 13, currentPrice: '0.000023',     marketCap: '13500000000.00'   },
  { name: 'Polkadot',         symbol: 'DOT',   rank: 14, currentPrice: '7.10',         marketCap: '10000000000.00'   },
  { name: 'Polygon',          symbol: 'MATIC', rank: 15, currentPrice: '0.91',         marketCap: '9500000000.00'    },
  { name: 'Chainlink',        symbol: 'LINK',  rank: 16, currentPrice: '14.80',        marketCap: '9200000000.00'    },
  { name: 'Bitcoin Cash',     symbol: 'BCH',   rank: 17, currentPrice: '440.00',       marketCap: '8700000000.00'    },
  { name: 'Litecoin',         symbol: 'LTC',   rank: 18, currentPrice: '95.00',        marketCap: '7100000000.00'    },
  { name: 'Cosmos',           symbol: 'ATOM',  rank: 19, currentPrice: '11.20',        marketCap: '4400000000.00'    },
  { name: 'Uniswap',          symbol: 'UNI',   rank: 20, currentPrice: '8.90',         marketCap: '5300000000.00'    },
  { name: 'Stellar',          symbol: 'XLM',   rank: 21, currentPrice: '0.13',         marketCap: '3600000000.00'    },
  { name: 'NEAR Protocol',    symbol: 'NEAR',  rank: 22, currentPrice: '5.40',         marketCap: '5800000000.00'    },
  { name: 'Filecoin',         symbol: 'FIL',   rank: 23, currentPrice: '5.80',         marketCap: '3200000000.00'    },
  { name: 'Ethereum Classic', symbol: 'ETC',   rank: 24, currentPrice: '27.00',        marketCap: '4000000000.00'    },
  { name: 'Hedera',           symbol: 'HBAR',  rank: 25, currentPrice: '0.082',        marketCap: '3000000000.00'    },
  { name: 'Aptos',            symbol: 'APT',   rank: 26, currentPrice: '10.20',        marketCap: '4500000000.00'    },
  { name: 'Arbitrum',         symbol: 'ARB',   rank: 27, currentPrice: '0.78',         marketCap: '3800000000.00'    },
  { name: 'VeChain',          symbol: 'VET',   rank: 28, currentPrice: '0.040',        marketCap: '2900000000.00'    },
  { name: 'Optimism',         symbol: 'OP',    rank: 29, currentPrice: '2.30',         marketCap: '2500000000.00'    },
  { name: 'Maker',            symbol: 'MKR',   rank: 30, currentPrice: '1620.00',      marketCap: '1450000000.00'    },
];
