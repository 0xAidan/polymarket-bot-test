# Polymarket API & Open Source Ecosystem — Exhaustive Research

> Research date: March 4, 2026
> Sources: docs.polymarket.com, gamma-api.polymarket.com, polymarket-data.com, GitHub, npm

---

## Table of Contents

1. [API Architecture Overview](#1-api-architecture-overview)
2. [CLOB API (Trading & Orderbook)](#2-clob-api-trading--orderbook)
3. [Gamma API (Markets & Events)](#3-gamma-api-markets--events)
4. [Data API (Positions, Trades, Activity)](#4-data-api-positions-trades-activity)
5. [WebSocket Channels](#5-websocket-channels)
6. [RTDS (Real-Time Data Socket)](#6-rtds-real-time-data-socket)
7. [Rate Limits](#7-rate-limits)
8. [Official SDKs & Open Source](#8-official-sdks--open-source)
9. [Community SDK (polymarket-data)](#9-community-sdk-polymarket-data)
10. [OpenAPI & AsyncAPI Specs](#10-openapi--asyncapi-specs)
11. [Key Findings for Bot Development](#11-key-findings-for-bot-development)

---

## 1. API Architecture Overview

Polymarket splits its API across **three base URLs** plus **four WebSocket channels**:

| API | Base URL | Auth Required | Purpose |
|-----|----------|---------------|---------|
| **CLOB API** | `https://clob.polymarket.com` | Yes (L2 HMAC) for trading; No for market data | Trading, orderbook, prices |
| **Gamma API** | `https://gamma-api.polymarket.com` | No | Market/event discovery, metadata, search |
| **Data API** | `https://data-api.polymarket.com` | No | Positions, trades, activity, analytics |

| WebSocket | Endpoint | Auth |
|-----------|----------|------|
| **Market** | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | No |
| **User** | `wss://ws-subscriptions-clob.polymarket.com/ws/user` | Yes (API creds) |
| **Sports** | `wss://sports-api.polymarket.com/ws` | No |
| **RTDS** | `wss://ws-live-data.polymarket.com` | Optional (gamma_auth) |

---

## 2. CLOB API (Trading & Orderbook)

**Base URL:** `https://clob.polymarket.com`

### Authentication

Two-level auth system:
- **L1 (EIP-712):** Private key signature — used once to derive API credentials
- **L2 (HMAC-SHA256):** API key/secret/passphrase — used for all subsequent requests

L2 Headers required:
| Header | Description |
|--------|-------------|
| `POLY_ADDRESS` | Wallet address |
| `POLY_SIGNATURE` | HMAC-SHA256 of request |
| `POLY_TIMESTAMP` | Unix timestamp |
| `POLY_API_KEY` | API key |
| `POLY_PASSPHRASE` | API passphrase |

### Public Endpoints (No Auth)

| Endpoint | Description |
|----------|-------------|
| `GET /book?token_id={id}` | Order book for a token |
| `POST /books` | Order books for multiple tokens |
| `GET /price?token_id={id}&side={BUY\|SELL}` | Best price for a token |
| `GET /prices` | Prices for multiple tokens |
| `GET /midpoint?token_id={id}` | Midpoint price |
| `GET /midpoints` | Midpoints for multiple tokens |
| `GET /spread?token_id={id}` | Spread |
| `GET /spreads` | Spreads for multiple tokens |
| `GET /last-trade-price?token_id={id}` | Last trade price and side |
| `GET /prices-history?market={id}&interval={val}&fidelity={val}` | Historical prices |
| `GET /tick-size?token_id={id}` | Min tick size |
| `GET /fee-rate?token_id={id}` | Fee rate |

### Authenticated Endpoints (L2)

| Endpoint | Description |
|----------|-------------|
| `GET /trades?maker_address={addr}` | **Get trades for a wallet** |
| `GET /order/{id}` | Single order by ID |
| `GET /orders` | User's open orders |
| `POST /order` | Place a new order |
| `DELETE /order/{id}` | Cancel single order |
| `DELETE /orders` | Cancel multiple orders |
| `DELETE /cancel-all` | Cancel all orders |

### GET /trades (CLOB) — Response Fields

**Parameters:**
- `maker_address` (required): `0x[a-fA-F0-9]{40}` wallet address
- `id` (optional): Trade ID
- `market` (optional): Condition ID
- `asset_id` (optional): Token ID
- `before` / `after` (optional): Unix timestamps
- `next_cursor` (optional): Base64 pagination cursor

**Response fields:** Trade ID, taker order ID, market condition ID, asset ID, plus pagination metadata (limit, cursor, count).

**Important:** This endpoint requires L2 authentication — you can only query your own trades.

---

## 3. Gamma API (Markets & Events)

**Base URL:** `https://gamma-api.polymarket.com`  
**Auth:** None required

### Key Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /events` | List events with filtering/pagination |
| `GET /events/{id}` | Single event by ID |
| `GET /events/{slug}` | Single event by slug |
| `GET /markets` | List markets with filtering/pagination |
| `GET /markets/{id}` | Single market by ID |
| `GET /markets/{slug}` | Single market by slug |
| `GET /public-search?query={q}` | Search across events, markets, profiles |
| `GET /tags` | Ranked tags/categories |
| `GET /series` | Series (grouped events) |
| `GET /series/{id}` | Single series |
| `GET /sports` | Sports metadata |
| `GET /teams` | Teams |

### Getting Top Markets by Volume

**Best approach — via Events endpoint:**

```
GET /events?active=true&closed=false&order=volume_24hr&ascending=false&limit=100
```

**Key query parameters for sorting:**
| Parameter | Values | Description |
|-----------|--------|-------------|
| `order` | `volume_24hr`, `volume`, `liquidity`, `start_date`, `end_date`, `competitive`, `closed_time` | Sort field |
| `ascending` | `true` / `false` (default: false) | Sort direction |
| `active` | `true` / `false` | Filter active markets |
| `closed` | `true` / `false` | Filter closed markets |
| `limit` | integer | Results per page |
| `offset` | integer | Pagination offset |

**Market object includes:**
- `outcomes` / `outcomePrices` arrays (map 1:1)
- `volume`, `volume_24hr`, `liquidity`
- `enableOrderBook` boolean
- Slug, description, tags, etc.

### Live Volume Endpoint

```
GET /live-volume?id={event_id}
```

Returns real-time total volume and per-market breakdown for a specific event.

---

## 4. Data API (Positions, Trades, Activity)

**Base URL:** `https://data-api.polymarket.com`  
**Auth:** None required (public data by wallet address)

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /trades` | Trade history (by user, market, or event) |
| `GET /activity` | Full activity feed for a wallet |
| `GET /positions?user={addr}` | Current positions for a user |
| `GET /closed-positions?user={addr}` | Closed positions |
| `GET /value?user={addr}` | Total position value |
| `GET /oi` | Open interest for a market |
| `GET /holders` | Top holders of a market |
| `GET /ok` | Health check |

### GET /trades (Data API) — Full Schema

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 100 | 0–10000 |
| `offset` | integer | 0 | 0–10000 |
| `takerOnly` | boolean | true | Only taker trades |
| `filterType` | string | — | `CASH` or `TOKENS` (requires filterAmount) |
| `filterAmount` | number | — | Min filter value (requires filterType) |
| `market` | string[] | — | Comma-separated condition IDs (mutually exclusive with eventId) |
| `eventId` | integer[] | — | Comma-separated event IDs (mutually exclusive with market) |
| `user` | string | — | Wallet address (`0x...40 hex chars`) |
| `side` | string | — | `BUY` or `SELL` |

**Response — Trade object fields:**
| Field | Type | Description |
|-------|------|-------------|
| `proxyWallet` | Address | Trader's proxy wallet |
| `side` | string | BUY or SELL |
| `asset` | string | Token asset |
| `conditionId` | Hash64 | Market condition ID |
| `size` | number | Trade size |
| `price` | number | Trade price |
| `timestamp` | int64 | Unix timestamp |
| `title` | string | Market title |
| `slug` | string | Market slug |
| `icon` | string | Market icon URL |
| `eventSlug` | string | Event slug |
| `outcome` | string | Outcome name |
| `outcomeIndex` | integer | Outcome index |
| `name` | string | User display name |
| `pseudonym` | string | User pseudonym |
| `bio` | string | User bio |
| `profileImage` | string | Profile image URL |
| `profileImageOptimized` | string | Optimized profile image |
| `transactionHash` | string | On-chain tx hash |

**Critical: This endpoint returns `proxyWallet` — wallet addresses are available without authentication!**

### GET /activity — Full Schema

**Parameters:**
| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `user` | Address | — | **Yes** | Wallet address |
| `limit` | integer | 100 | No | 0–500 |
| `offset` | integer | 0 | No | 0–10000 |
| `market` | Hash64[] | — | No | Condition IDs (mutually exclusive with eventId) |
| `eventId` | integer[] | — | No | Event IDs (mutually exclusive with market) |
| `type` | string[] | — | No | `TRADE`, `SPLIT`, `MERGE`, `REDEEM`, `REWARD`, `CONVERSION`, `MAKER_REBATE` |
| `start` / `end` | integer | — | No | Unix timestamp bounds |
| `sortBy` | string | TIMESTAMP | No | `TIMESTAMP`, `TOKENS`, `CASH` |
| `sortDirection` | string | DESC | No | `ASC` or `DESC` |
| `side` | string | — | No | `BUY` or `SELL` |

**Response — Activity object fields:**
| Field | Type | Description |
|-------|------|-------------|
| `proxyWallet` | Address | Wallet |
| `timestamp` | int64 | Unix timestamp |
| `conditionId` | Hash64 | Market condition ID |
| `type` | string | Activity type enum |
| `size` | number | Token size |
| `usdcSize` | number | USDC value |
| `transactionHash` | string | On-chain tx hash |
| `price` | number | Price |
| `asset` | string | Token asset |
| `side` | string | BUY or SELL |
| `outcomeIndex` | integer | Outcome index |
| `title` | string | Market title |
| `slug` | string | Market slug |
| `icon` | string | Icon URL |
| `eventSlug` | string | Event slug |
| `outcome` | string | Outcome name |
| `name` | string | User display name |
| `pseudonym` | string | User pseudonym |
| `bio` | string | User bio |
| `profileImage` | string | Profile image |
| `profileImageOptimized` | string | Optimized image |

---

## 5. WebSocket Channels

### Market Channel (Public)

**Endpoint:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`  
**Auth:** None  
**Heartbeat:** Send `PING` every 10s, server responds `PONG`

**Subscription message:**
```json
{
  "assets_ids": ["<token_id_1>", "<token_id_2>"],
  "type": "market",
  "custom_feature_enabled": true
}
```

**Message types:**

| Type | Trigger | Key Fields |
|------|---------|------------|
| `book` | On subscribe + after trades | `bids[]`, `asks[]` (price, size), `asset_id`, `market`, `timestamp` |
| `price_change` | New order or cancel | `price_changes[]` (asset_id, price, size, side, best_bid, best_ask) |
| `tick_size_change` | Price hits extremes (<0.04 or >0.96) | `old_tick_size`, `new_tick_size` |
| `last_trade_price` | Trade execution | `asset_id`, `price`, `side`, `size`, `fee_rate_bps`, `market`, `timestamp` |
| `best_bid_ask` | Best prices change (custom feature) | `best_bid`, `best_ask`, `spread` |
| `new_market` | Market created (custom feature) | `id`, `question`, `slug`, `assets_ids[]`, `outcomes[]`, `event_message` |
| `market_resolved` | Market resolved (custom feature) | `winning_asset_id`, `winning_outcome` |

**`last_trade_price` example:**
```json
{
  "asset_id": "114122...",
  "event_type": "last_trade_price",
  "fee_rate_bps": "0",
  "market": "0x6a67...",
  "price": "0.456",
  "side": "BUY",
  "size": "219.217767",
  "timestamp": "1750428146322"
}
```

**Does NOT include wallet addresses.** Only price, side, size, asset_id, market, fee_rate_bps, timestamp.

### User Channel (Authenticated)

**Endpoint:** `wss://ws-subscriptions-clob.polymarket.com/ws/user`  
**Auth:** API credentials required  
**Subscribes by condition IDs, not asset IDs**

```json
{
  "auth": {
    "apiKey": "your-api-key",
    "secret": "your-api-secret",
    "passphrase": "your-passphrase"
  },
  "markets": ["0x1234...condition_id"],
  "type": "user"
}
```

| Type | Description |
|------|-------------|
| `trade` | Trade lifecycle updates (MATCHED → CONFIRMED) |
| `order` | Order placements, updates, cancellations |

### Sports Channel

**Endpoint:** `wss://sports-api.polymarket.com/ws`  
**Auth:** None  
**Heartbeat:** Server sends `ping` every 5s, respond with `pong` within 10s  
**No subscription message required** — auto-receives all active sports events.

| Type | Description |
|------|-------------|
| `sport_result` | Live game scores, periods, status |

### Dynamic Subscription (Market & User)

Add/remove subscriptions without reconnecting:
```json
{
  "assets_ids": ["new_asset_id"],
  "operation": "subscribe",
  "custom_feature_enabled": true
}
```

---

## 6. RTDS (Real-Time Data Socket)

**Endpoint:** `wss://ws-live-data.polymarket.com`  
**Auth:** Optional `gamma_auth` for user-specific streams  
**Heartbeat:** `PING` every 5 seconds  
**npm package:** `@polymarket/real-time-data-client` (v1.4.0, 175 GitHub stars)

### Subscription Format

```json
{
  "action": "subscribe",
  "subscriptions": [
    {
      "topic": "topic_name",
      "type": "message_type",
      "filters": "optional_filter_string",
      "gamma_auth": { "address": "wallet_address" }
    }
  ]
}
```

### Available Topics

| Topic | Types | Auth | Description |
|-------|-------|------|-------------|
| `crypto_prices` | `update` | No | Binance prices (solusdt, btcusdt, ethusdt, xrpusdt) |
| `crypto_prices_chainlink` | `update`, `*` | No | Chainlink prices (eth/usd, btc/usd, sol/usd, xrp/usd) |
| `comments` | `comment_created`, `comment_removed`, `reaction_created`, `reaction_removed` | Optional | Comment events on markets |
| `activity` | `trades`, `orders_matched` | Optional | Trade activity streams |

### Crypto Prices Payload

```json
{
  "topic": "crypto_prices",
  "type": "update",
  "timestamp": 1753314064237,
  "payload": {
    "symbol": "btcusdt",
    "timestamp": 1753314064213,
    "value": 67234.50
  }
}
```

### Comments Payload (includes wallet addresses!)

```json
{
  "topic": "comments",
  "type": "comment_created",
  "timestamp": 1753454975808,
  "payload": {
    "body": "comment text",
    "id": "1763355",
    "parentEntityID": 18396,
    "parentEntityType": "Event",
    "profile": {
      "baseAddress": "0xce533...",
      "name": "username",
      "proxyWallet": "0x4ca749...",
      "pseudonym": "Pseudonym"
    },
    "userAddress": "0xce533..."
  }
}
```

### RTDS Does NOT Provide Trade Wallet Addresses

The RTDS `activity` topic streams trade events but the documentation shows it streams market-level trade data (similar to `last_trade_price`), not per-wallet trade details.

### Known Issues

- Data stream reportedly stops after ~20 minutes despite healthy ping/pong (GitHub issue #26)
- Connection state shows OPEN but messages cease

---

## 7. Rate Limits

All limits enforced via Cloudflare throttling (delayed, not rejected). Sliding time windows.

### Gamma API (`gamma-api.polymarket.com`)

| Endpoint | Limit |
|----------|-------|
| General | 4,000 req / 10s |
| `/events` | 500 req / 10s |
| `/markets` | 300 req / 10s |
| `/markets` + `/events` listing | 900 req / 10s |
| `/comments` | 200 req / 10s |
| `/tags` | 200 req / 10s |
| `/public-search` | 350 req / 10s |

### Data API (`data-api.polymarket.com`)

| Endpoint | Limit |
|----------|-------|
| General | 1,000 req / 10s |
| `/trades` | 200 req / 10s |
| `/positions` | 150 req / 10s |
| `/closed-positions` | 150 req / 10s |
| Health check | 100 req / 10s |

### CLOB API (`clob.polymarket.com`)

| Category | Endpoint | Limit |
|----------|----------|-------|
| General | — | 9,000 req / 10s |
| Market Data | `/book` | 1,500 req / 10s |
| Market Data | `/books` | 500 req / 10s |
| Market Data | `/price` | 1,500 req / 10s |
| Market Data | `/prices-history` | 1,000 req / 10s |
| Ledger | `/trades`, `/orders` | 900 req / 10s |
| Trading | `POST /order` | 3,500 burst / 10s, 36,000 sustained / 10min |
| Trading | `DELETE /order` | 3,000 burst / 10s, 30,000 sustained / 10min |
| Auth | API key endpoints | 100 req / 10s |

### Other

| Endpoint | Limit |
|----------|-------|
| General rate limiting | 15,000 req / 10s |
| Relayer `/submit` | 25 req / 1 min |
| User PNL API | 200 req / 10s |

---

## 8. Official SDKs & Open Source

### CLOB Client SDKs

| Language | Package | Repository | Stars |
|----------|---------|------------|-------|
| TypeScript | `@polymarket/clob-client` (v5.5.0) | [Polymarket/clob-client](https://github.com/Polymarket/clob-client) | ~450 |
| Python | `py-clob-client` | [Polymarket/py-clob-client](https://github.com/Polymarket/py-clob-client) | ~837 |
| Rust | `polymarket-client-sdk` | [Polymarket/rs-clob-client](https://github.com/Polymarket/rs-clob-client) | ~559 |

**Installation:**
```bash
npm install @polymarket/clob-client ethers@5
pip install py-clob-client
cargo add polymarket-client-sdk
```

### Builder SDKs (Order Attribution)

| Language | Package | Repository |
|----------|---------|------------|
| TypeScript | `@polymarket/builder-signing-sdk` | [Polymarket/builder-signing-sdk](https://github.com/Polymarket/builder-signing-sdk) |
| Python | `py_builder_signing_sdk` | [Polymarket/py-builder-signing-sdk](https://github.com/Polymarket/py-builder-signing-sdk) |

### Relayer SDKs (Gasless Transactions)

| Language | Package | Repository |
|----------|---------|------------|
| TypeScript | `@polymarket/builder-relayer-client` | [Polymarket/builder-relayer-client](https://github.com/Polymarket/builder-relayer-client) |
| Python | `py-builder-relayer-client` | [Polymarket/py-builder-relayer-client](https://github.com/Polymarket/py-builder-relayer-client) |

### RTDS Client

| Language | Package | Repository |
|----------|---------|------------|
| TypeScript | `@polymarket/real-time-data-client` (v1.4.0) | [Polymarket/real-time-data-client](https://github.com/Polymarket/real-time-data-client) |

**Dependencies:** ws, tslib, isomorphic-ws

### WebSocket Capabilities of `@polymarket/clob-client`

The clob-client itself does **not** include WebSocket functionality directly. WebSocket connections are separate:
- **Market Channel:** `wss://ws-subscriptions-clob.polymarket.com/ws/market` — direct WebSocket connection, no SDK wrapper
- **User Channel:** `wss://ws-subscriptions-clob.polymarket.com/ws/user` — requires auth credentials from the clob-client
- **RTDS:** Use `@polymarket/real-time-data-client` separately

---

## 9. Community SDK (polymarket-data)

**Website:** [polymarket-data.com](https://polymarket-data.com)  
**Status:** Community-maintained TypeScript SDK (NOT officially affiliated with Polymarket)

### Architecture

Wraps both Data API and Gamma API behind a single `Polymarket` constructor with two HTTP clients.

### Available Modules

| Module | Method Examples | Description |
|--------|----------------|-------------|
| `client.data.core` | `getTrades()`, `getActivity()`, `getPositions()`, `getClosedPositions()` | Core data endpoints |
| `client.data.misc` | `getOpenInterest()`, `getValue()` | Misc analytics |
| `client.gamma.markets` | `listMarkets()` | Market discovery |
| `client.gamma.events` | `listEvents()` | Event discovery |
| `client.gamma.series` | — | Series |
| `client.gamma.comments` | — | Comments |
| `client.gamma.sports` | — | Sports metadata |
| `client.gamma.search` | — | Search |

### Features

- All request/response validated with Zod for runtime and IDE safety
- Live examples exercised against production APIs
- Strong TypeScript typing throughout
- Supports all filtering/pagination from the underlying APIs

---

## 10. OpenAPI & AsyncAPI Specs

Polymarket publishes machine-readable API specs:

### OpenAPI Specs
| Spec | URL |
|------|-----|
| CLOB API | `https://docs.polymarket.com/api-spec/clob-openapi.yaml` |
| Gamma API | `https://docs.polymarket.com/api-spec/gamma-openapi.yaml` |
| Data API | `https://docs.polymarket.com/api-spec/data-openapi.yaml` |
| Bridge API | `https://docs.polymarket.com/api-spec/bridge-openapi.yaml` |
| Full API Reference | `https://docs.polymarket.com/api-reference/openapi.json` |

### AsyncAPI Specs (WebSocket)
| Spec | URL |
|------|-----|
| Market Channel | `https://docs.polymarket.com/asyncapi.json` |
| User Channel | `https://docs.polymarket.com/asyncapi-user.json` |
| Sports Channel | `https://docs.polymarket.com/asyncapi-sports.json` |

### Full Documentation Index
Available at `https://docs.polymarket.com/llms.txt` — complete page listing with all endpoints.

---

## 11. Key Findings for Bot Development

### Getting Trades with Wallet Addresses

| Method | Endpoint | Wallet Data | Auth | Best For |
|--------|----------|-------------|------|----------|
| **Data API /trades** | `data-api.polymarket.com/trades` | `proxyWallet` + profile info | **None** | Public trade monitoring |
| **Data API /activity** | `data-api.polymarket.com/activity` | `proxyWallet` + profile info | **None** | Full wallet activity |
| CLOB API /trades | `clob.polymarket.com/trades` | `maker_address` only | L2 HMAC | Own-wallet queries only |

**Winner: Data API `/trades` and `/activity` — public, no auth, includes wallet addresses.**

### Getting Trades by Market

- **Data API `/trades`:** Pass `market=0x...conditionId` (comma-separated for multiple)
- **Data API `/trades`:** Pass `eventId=123` as alternative
- **Data API `/activity`:** Same `market` and `eventId` params

### Real-Time Trade Monitoring

| Channel | Wallet Addresses | Trade Details | Auth |
|---------|-----------------|---------------|------|
| Market WS `last_trade_price` | **No** | price, size, side, asset_id | None |
| User WS `trade` | Only your own | Full lifecycle | Yes |
| RTDS `activity` | **TBD** | trades, orders_matched | Optional |

**For real-time trade monitoring with wallet addresses:** No WebSocket provides other users' wallet addresses in real-time. You must poll the Data API `/trades` endpoint to get `proxyWallet`.

### Recommended Architecture for a Trade-Tracking Bot

1. **Discovery:** Gamma API `/events?order=volume_24hr` → get top markets
2. **Real-time prices:** Market Channel WebSocket → `last_trade_price` events
3. **Trade details with wallets:** Poll Data API `/trades?market={id}` at intervals
4. **User activity:** Data API `/activity?user={addr}` for specific wallet tracking
5. **Positions:** Data API `/positions?user={addr}` for current holdings

### Rate Limit Budget

At 200 req/10s for Data API `/trades`, you can poll:
- 20 markets every second
- Or 1 market 20 times per second
- Realistic: poll top 50 markets every 2.5 seconds
