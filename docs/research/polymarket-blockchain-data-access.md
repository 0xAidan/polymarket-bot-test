# Polymarket Blockchain-Level Trade Data: Exhaustive Research

> Last updated: March 4, 2026

---

## 1. Smart Contracts on Polygon

All Polymarket contracts are deployed on **Polygon mainnet (Chain ID: 137)**.

### Core Trading Contracts

| Contract | Address | Purpose |
|----------|---------|---------|
| **CTF Exchange** | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | Standard binary market order matching and settlement |
| **Neg Risk CTF Exchange** | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | Multi-outcome (3+) market order matching |
| **Neg Risk Adapter** | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | Converts No tokens between outcomes in neg risk markets |
| **Conditional Tokens (CTF)** | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | ERC1155 token storage — split, merge, redeem |
| **USDC.e (Collateral)** | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | Bridged USDC, 6 decimals |

**PolygonScan links:**
- CTF Exchange: https://polygonscan.com/address/0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e
- Neg Risk CTF Exchange: https://polygonscan.com/address/0xc5d563a36ae78145c45a50134d48a1215220f80a

**Source code:** https://github.com/Polymarket/ctf-exchange (MIT License, audited by ChainSecurity)

### Wallet Factory Contracts

| Contract | Address | Purpose |
|----------|---------|---------|
| Gnosis Safe Factory | `0xaacfeea03eb1561c4e67d661e40682bd20e3541b` | Deploys Safe wallets |
| Polymarket Proxy Factory | `0xaB45c5A4B0c941a2F231C04C3f49182e1A254052` | Deploys proxy wallets |

### Resolution Contracts

| Contract | Address | Purpose |
|----------|---------|---------|
| UMA Adapter | `0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74` | Connects to UMA Optimistic Oracle |
| UMA Optimistic Oracle | `0xCB1822859cEF82Cd2Eb4E6276C7916e692995130` | Handles resolution proposals/disputes |

---

## 2. Contract Events (Trade Events)

From the actual Solidity source (`src/exchange/interfaces/ITrading.sol`):

### `OrderFilled` Event

```solidity
event OrderFilled(
    bytes32 indexed orderHash,
    address indexed maker,
    address indexed taker,
    uint256 makerAssetId,
    uint256 takerAssetId,
    uint256 makerAmountFilled,
    uint256 takerAmountFilled,
    uint256 fee
);
```

**Topic0 (keccak256):** `keccak256("OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)")`

**Key fields:**
- `orderHash` (indexed) — EIP-712 hash of the order
- `maker` (indexed) — **YES, contains the maker's wallet address**
- `taker` (indexed) — **YES, contains the taker's wallet address**
- `makerAssetId` — Token ID of asset sold (0 = USDC.e collateral, otherwise ERC1155 token ID)
- `takerAssetId` — Token ID of asset received
- `makerAmountFilled` — Amount of maker's asset filled
- `takerAmountFilled` — Amount of taker's asset filled
- `fee` — Fee charged on the trade

### `OrdersMatched` Event

```solidity
event OrdersMatched(
    bytes32 indexed takerOrderHash,
    address indexed takerOrderMaker,
    uint256 makerAssetId,
    uint256 takerAssetId,
    uint256 makerAmountFilled,
    uint256 takerAmountFilled
);
```

**Key fields:**
- `takerOrderHash` (indexed) — Hash of the taker order
- `takerOrderMaker` (indexed) — **YES, the taker's wallet address**
- Asset IDs and fill amounts

### `OrderCancelled` Event

```solidity
event OrderCancelled(bytes32 indexed orderHash);
```

### `FeeCharged` Event

```solidity
event FeeCharged(address indexed receiver, uint256 tokenId, uint256 fee);
```

### Critical Note: Proxy Wallet Addresses

The `maker` and `taker` addresses in events are **proxy wallet addresses**, NOT the user's EOA/base address. Polymarket users trade through:
- **GNOSIS_SAFE (Type 2)** — Browser/embedded wallet accounts
- **POLY_PROXY (Type 1)** — Magic Link (email/Google) accounts
- **EOA (Type 0)** — Standalone wallets (rare)

**To map proxy → real user:** Use the Polymarket Profile API:
```
GET https://data-api.polymarket.com/public-profile?address=<proxy_or_user_address>
```
Returns: `proxyWallet`, `name`, `pseudonym`, `xUsername`, `verifiedBadge`

---

## 3. Subgraphs and Indexers

### Official Goldsky-Hosted Subgraphs

Polymarket maintains **5 specialized subgraphs** hosted by Goldsky (public, free endpoints):

| Subgraph | Endpoint | Description |
|----------|----------|-------------|
| **Orders** | `https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn` | Order book and trade events |
| **Positions** | `https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/positions-subgraph/0.0.7/gn` | User token balances |
| **Activity** | `https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/activity-subgraph/0.0.4/gn` | Splits, merges, redemptions |
| **Open Interest** | `https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/oi-subgraph/0.0.6/gn` | Per-market and global OI |
| **PNL** | `https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/pnl-subgraph/0.0.14/gn` | User position P&L |

**Docs:** https://docs.polymarket.com/market-data/subgraph
**Source:** https://github.com/Polymarket/polymarket-subgraph (187 stars, 52 forks)

### Goldsky Rate Limits

| Plan | Rate Limit | Cost |
|------|-----------|------|
| Starter (free) | 20 requests / 10 seconds | Free |
| Scale | 50 requests / 10 seconds | Paid |
| Enterprise | 1,000+ requests / 10 seconds | Custom |

Default public endpoint rate limit: **50 requests per 10 seconds** (contact support for increases).

### Orders Subgraph — Key Schema

The **orderbook-subgraph** is the most relevant for trade tracking:

```graphql
# Query: Get latest trade fills with wallet addresses
{
  orderFilledEvents(first: 10, orderBy: timestamp, orderDirection: desc) {
    id
    transactionHash
    timestamp
    maker             # wallet address of maker
    taker             # wallet address of taker
    makerAssetId
    takerAssetId
    makerAmountFilled
    takerAmountFilled
    fee
    side
    price
  }
}
```

```graphql
# Query: Get order match events
{
  ordersMatchedEvents(first: 10, orderBy: timestamp, orderDirection: desc) {
    id
    transactionHash
    timestamp
    takerOrderHash
    takerOrderMaker   # taker's wallet address
    makerAssetId
    takerAssetId
    makerAmountFilled
    takerAmountFilled
  }
}
```

### The Graph Network Deployment

Polymarket subgraphs are also available on The Graph's decentralized network:
- **Endpoint:** `https://gateway.thegraph.com/api/{api-key}/subgraphs/id/Bx1W4S7kDVxs9gC3s2G6DS8kdNBJNVhMviCtin2DiBp`
- **Free tier:** 100,000 queries/month with a free API key
- **Get API key:** https://thegraph.com/studio/apikeys/
- **Docs:** https://thegraph.com/docs/ar/subgraphs/guides/polymarket/

### Envio / HyperSync

Envio's HyperSync supports Polygon and could index Polymarket contracts (2000x faster than RPC). However, **no official Polymarket Envio integration exists**. You would need to configure your own HyperIndex with the Polymarket contract addresses and event signatures.
- **Docs:** https://docs.envio.dev/docs/hypersync
- **Supports:** 70+ EVM chains including Polygon

---

## 4. Polymarket/real-time-data-client

**Repo:** https://github.com/Polymarket/real-time-data-client
**Stars:** 175 | **Language:** TypeScript (94.8%) | **License:** MIT
**Latest release:** v1.4.0 (July 25, 2025)

### What It Does

A TypeScript WebSocket client that connects to Polymarket's real-time data streaming service at `wss://ws-live-data.polymarket.com`.

### Supported Data Streams

| Topic | Type | Description |
|-------|------|-------------|
| `crypto_prices` | `update` | Real-time crypto prices from Binance |
| `crypto_prices_chainlink` | `update` | Real-time crypto prices from Chainlink |
| `comments` | `comment_created`, `comment_removed`, `reaction_created`, `reaction_removed` | Comment activity |

### Important Limitation

The RTDS currently streams **comments and crypto prices only**. It does NOT stream trade/order data directly. The `matched orders` mentioned in older documentation appears to have been removed or is not publicly documented.

### Usage

```typescript
import { RealTimeDataClient } from "@polymarket/real-time-data-client";

const client = new RealTimeDataClient({
  onMessage: (msg) => console.log(msg),
  onConnect: () => console.log("Connected"),
});

client.connect();
```

### Connection Requirements
- Send `PING` every 5 seconds to keep connection alive
- User-specific streams may require `gamma_auth` with wallet address
- Supports dynamic subscribe/unsubscribe without disconnecting

---

## 5. Polygonscan API

### Event Log Querying

**Endpoint:**
```
https://api.etherscan.io/v2/api?chainid=137&module=logs&action=getLogs
  &fromBlock=START
  &toBlock=END
  &address=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
  &topic0=ORDERFILLED_TOPIC0_HASH
  &apikey=YOUR_API_KEY
```

**Parameters:**
- `chainid=137` (Polygon)
- `address` — Polymarket contract address
- `topic0` — keccak256 hash of the event signature
- `fromBlock` / `toBlock` — Block range

### Rate Limits

| Metric | Limit |
|--------|-------|
| Calls per second | 5 |
| Calls per day | 100,000 |
| Records per call | 1,000 |

### Capabilities
- Query event logs by contract address + topic0
- Filter by block range
- Get transaction history (normal + internal)
- Token transfer events (ERC20, ERC721)
- Account balance queries

### Limitations
- **Not real-time** — polling only, no WebSocket support
- **1,000 records per call** cap means you need pagination for large ranges
- **5 calls/second** is tight for high-frequency monitoring
- No webhook/push notification support

---

## 6. Dune Analytics

### Curated Polymarket Tables

Dune provides curated tables in the `polymarket_polygon` schema:

| Table | Key Columns | Description |
|-------|-------------|-------------|
| `polymarket_polygon.market_trades` | `block_time`, `question`, `amount`, `condition_id`, `token_outcome`, `address` | Individual trade fills |
| `polymarket_polygon.positions` | `address`, `condition_id`, `token_id`, `balance`, `value_usd` | Current user positions |
| `polymarket_polygon.market_prices_hourly` | `hour`, `condition_id`, `token_id`, `price` | Hourly price snapshots |
| `polymarket_polygon.market_prices_daily` | Similar to hourly | Daily price snapshots |

**Dashboards:**
- Official: https://dune.com/polymarket_analytics
- Community dashboards for volume, TVL, open interest, whale tracking

### Dune API for Programmatic Access

**Endpoint:** `https://api.dune.com/api/v1/query/{query_id}/execute`

| Plan | Monthly Price | Credits | API Calls/min | Export Cost |
|------|---------------|---------|---------------|-------------|
| Free | $0 | 2,500 | 40 | 20 credits/MB |
| Analyst | $65/mo | 4,000 | 40 | 10 credits/MB |
| Plus | $349/mo | 25,000 | 200 | 2 credits/MB |
| Enterprise | Custom | Custom | Custom | Custom |

### Key Limitations
- **~24 hour refresh rate** — NOT real-time
- `market_trades` table requires `block_time` filter for performance
- Failed query executions still consume credits
- Best for analytics/dashboards, not real-time monitoring

---

## 7. RPC Streaming (Real-Time)

### eth_subscribe via WebSocket

Direct WebSocket connection to Polygon RPC for real-time event streaming.

**Subscription format:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_subscribe",
  "params": [
    "logs",
    {
      "address": "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
      "topics": ["ORDERFILLED_TOPIC0_HASH"]
    }
  ]
}
```

**Response on each event:**
```json
{
  "subscription": "0x...",
  "result": {
    "address": "0x4bfb41d5...",
    "topics": ["0x...", "0x...(orderHash)", "0x...(maker)", "0x...(taker)"],
    "data": "0x...(makerAssetId, takerAssetId, amounts, fee)",
    "blockNumber": "0x...",
    "transactionHash": "0x...",
    "logIndex": "0x...",
    "removed": false
  }
}
```

### Provider Options

#### Alchemy
- **WSS:** `wss://polygon-mainnet.g.alchemy.com/v2/{apiKey}`
- **Supports:** `eth_subscribe("logs")` with address + topic filters
- **Also offers:** Webhooks for mined transactions, address activity, NFT activity
- **Docs:** https://docs.alchemy.com/reference/eth-subscribe-polygon
- **Free tier:** 300M compute units/month

#### QuickNode
- **Webhooks:** Pre-built "Contract Events" monitoring templates, 30 credits per payload
- **Streams:** Historical backfilling + real-time, server-side JS filtering, exactly-once delivery
- **Supports:** Polygon Mainnet + Amoy Testnet
- **Docs:** https://www.quicknode.com/docs/streams

#### Infura
- **WSS:** `wss://polygon-mainnet.infura.io/ws/v3/{projectId}`
- **Supports:** eth_subscribe("logs") with filters
- **Docs:** https://www.infura.io/blog/post/how-to-use-websocket-subscriptions-with-the-infura-polygon-wss-api

#### Chainstack
- **Supports:** eth_subscribe("logs") with full filter params
- **Docs:** https://chainstack.readme.io/reference/polygon-native-subscribe-logs

---

## 8. Polymarket's Own CLOB API

### Trades Endpoint (No Auth Required)

**Base URL:** `https://data-api.polymarket.com`

```
GET /trades?user=0x...&market=CONDITION_ID&side=BUY&limit=100&offset=0
```

**Parameters:**
- `user` — Filter by wallet address (0x format)
- `market` — Comma-separated condition IDs
- `eventId` — Comma-separated event IDs
- `side` — BUY or SELL
- `limit` — Max 10,000 per request
- `takerOnly` — Boolean (default: true)
- `filterType` — CASH or TOKENS
- `filterAmount` — Minimum amount filter

**SDKs:**
- TypeScript: `npm install @polymarket/clob-client`
- Python: `pip install py-clob-client`

---

## 9. Other Data Providers

### Bitquery
- Provides decoded Polymarket event data via GraphQL API
- Can query OrderFilled events from both CTF Exchange and Neg Risk CTF Exchange
- **Playground:** https://ide.bitquery.io/Polymarket-Neg-Risk-CTF-Exchange-contract----OrderFilled-Event
- **Docs:** https://docs.bitquery.io/docs/examples/polymarket-api/

### Allium
- SQL-queryable blockchain data including Polymarket
- Referenced in Polymarket's official docs as a data resource

### Token Terminal
- Tracks Polymarket as `polymarket_v1_polygon`
- Events tracked: OrderFilled, FeeCharged, NewAdmin
- **Docs:** https://tokenterminal.com/docs/queries/tt-contracts/polymarket_v1_polygon

### PolyAlertHub
- Whale alerts, whale trades, whale positions tracking
- **URL:** https://polyalerthub.com

---

## 10. Comparison: Which Approach to Use?

| Approach | Latency | Wallet Addresses? | Historical Data? | Cost | Complexity |
|----------|---------|-------------------|------------------|------|------------|
| **RPC WebSocket (eth_subscribe)** | Real-time (~2s) | Yes (proxy) | No (live only) | Free tier available | Medium — need to decode ABI |
| **Goldsky Subgraph** | Near real-time (~30s) | Yes (proxy) | Yes | Free (rate limited) | Low — GraphQL |
| **The Graph Network** | Near real-time (~30s) | Yes (proxy) | Yes | 100k queries/mo free | Low — GraphQL |
| **Polygonscan API** | Polling (~10s+) | Yes (proxy) | Yes | Free (rate limited) | Low — REST |
| **Polymarket CLOB API** | Near real-time | Yes (proxy) | Yes | Free | Very low — REST |
| **Dune Analytics** | ~24 hour delay | Yes | Yes | Free tier available | Medium — SQL |
| **QuickNode Streams** | Real-time | Yes (proxy) | Yes (backfill) | Paid | Medium |
| **Alchemy Webhooks** | Real-time | Yes (proxy) | No | Free tier available | Medium |
| **Bitquery** | Near real-time | Yes (proxy) | Yes | Paid | Low — GraphQL |

### Recommended Stack for a Whale Tracking Bot

1. **Primary (real-time):** Alchemy/QuickNode WebSocket `eth_subscribe("logs")` on both CTF Exchange and Neg Risk CTF Exchange contracts, filtering for `OrderFilled` events
2. **Enrichment:** Polymarket CLOB API `/trades` endpoint to get market context (question text, condition IDs)
3. **Identity resolution:** Polymarket Profile API to map proxy wallets → usernames
4. **Historical backfill:** Goldsky orderbook subgraph via GraphQL
5. **Analytics:** Dune for dashboards and complex SQL analysis

---

## 11. Code Snippets

### Computing OrderFilled Topic0

```typescript
import { ethers } from "ethers";

const ORDER_FILLED_TOPIC = ethers.id(
  "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)"
);

const ORDERS_MATCHED_TOPIC = ethers.id(
  "OrdersMatched(bytes32,address,uint256,uint256,uint256,uint256)"
);
```

### WebSocket Subscription (ethers.js v6)

```typescript
import { ethers } from "ethers";

const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

const ORDER_FILLED_ABI = [
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)"
];

const provider = new ethers.WebSocketProvider("wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY");

const ctfContract = new ethers.Contract(CTF_EXCHANGE, ORDER_FILLED_ABI, provider);
const negRiskContract = new ethers.Contract(NEG_RISK_EXCHANGE, ORDER_FILLED_ABI, provider);

ctfContract.on("OrderFilled", (orderHash, maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee) => {
  console.log({
    orderHash,
    maker,       // proxy wallet address
    taker,       // proxy wallet address (usually the CLOB operator)
    makerAssetId: makerAssetId.toString(),
    takerAssetId: takerAssetId.toString(),
    makerAmountFilled: makerAmountFilled.toString(),
    takerAmountFilled: takerAmountFilled.toString(),
    fee: fee.toString(),
  });
});
```

### Goldsky Subgraph Query

```bash
curl -X POST \
  "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "{ orderFilledEvents(first: 5, orderBy: timestamp, orderDirection: desc) { id transactionHash timestamp maker taker makerAssetId takerAssetId makerAmountFilled takerAmountFilled fee } }"
  }'
```

### Polygonscan API Event Logs

```bash
curl "https://api.etherscan.io/v2/api?chainid=137&module=logs&action=getLogs&fromBlock=55000000&toBlock=latest&address=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E&topic0=ORDER_FILLED_TOPIC0&apikey=YOUR_KEY"
```

### Polymarket Profile Lookup

```bash
curl "https://data-api.polymarket.com/public-profile?address=0xPROXY_WALLET_ADDRESS"
```

---

## Sources

- Polymarket Docs — Contract Addresses: https://docs.polymarket.com/developers/CTF/deployment-resources
- Polymarket Docs — Subgraph: https://docs.polymarket.com/market-data/subgraph
- Polymarket Docs — RTDS: https://docs.polymarket.com/developers/RTDS/RTDS-overview
- Polymarket Docs — Trades API: https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets
- Polymarket Docs — Proxy Wallets: https://docs.polymarket.com/developers/proxy-wallet
- CTF Exchange Source: https://github.com/Polymarket/ctf-exchange
- Subgraph Source: https://github.com/Polymarket/polymarket-subgraph
- Real-Time Data Client: https://github.com/Polymarket/real-time-data-client
- The Graph Polymarket Guide: https://thegraph.com/docs/ar/subgraphs/guides/polymarket/
- Goldsky Pricing: https://docs.goldsky.com/pricing/summary
- Polygonscan API: https://docs.polygonscan.com/api-endpoints/logs
- Dune Polymarket Tables: https://docs.dune.com/data-catalog/curated/prediction-markets/overview
- Dune Pricing: https://dune.com/pricing
- Alchemy WebSocket: https://docs.alchemy.com/reference/eth-subscribe-polygon
- QuickNode Streams: https://www.quicknode.com/docs/streams
