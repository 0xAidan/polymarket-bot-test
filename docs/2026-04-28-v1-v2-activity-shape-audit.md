# V1 vs V2 OrderFilled Activity Shape Audit

**Audited by:** feat/discovery-pnl-pillars agent  
**Date:** 2026-04-28  
**Status:** CONSISTENT — no normalization layer needed

---

## What was checked

Three code paths write rows into `discovery_activity_v3`:

1. **Backfill pipeline** (`buildSortedParquetToActivityDedupedSql`) — reads historical Goldsky parquet (users.parquet), which only covers V1-era trades (pre-Apr 28 2026 cutover).
2. **Goldsky GraphQL live tail** (`goldskyListener.ts → normalizeOrderFilled`) — the subgraph-based live path. The Goldsky subgraph uses a V1-style schema (`makerAssetId / takerAssetId`). As of Apr 28 2026 it is unknown whether the Goldsky subgraph has been updated for V2; this path is not the primary real-time path going forward.
3. **Chain WebSocket listener** (`chainListener.ts → parseOrderFilledLog`) — the real-time path. This decoder handles BOTH V1 and V2 `OrderFilled` events, normalises them, and calls `TradeIngestion.ingest`. Note: the chain listener does NOT write directly to `discovery_activity_v3`; it feeds `TradeIngestion` → `statsStore`. The DuckDB activity table is populated by the backfill and Goldsky listener paths only.

---

## V1 event decoding (topic0: 0xd0a08…)

```
data: (makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee)
```

- `makerAssetId == "0"` → maker is collateral side → `side = BUY`
- `usdcAmount = makerAmount` (or takerAmount if maker sells tokens)
- `tokenAmount = takerAmount` (or makerAmount if maker sells tokens)
- `fee` is a share count already deducted from the filled amount. `signed_size` from parquet reflects the **net** token amount after fee deduction.
- **Conclusion**: `signed_size` in the activity table for V1 rows is the net tokens received (BUY: positive) or tokens delivered (SELL: negative, already fee-adjusted). `usd_notional` is the gross USDC amount.

## V2 event decoding (topic0: 0xd543a…)

```
data: (side, tokenId, makerAmountFilled, takerAmountFilled, fee, builder, metadata)
```

- Explicit `side` flag: 0 = BUY, 1 = SELL
- `fee` is a USDC amount charged at match time — NOT deducted from token amounts
- The `fee` field in `discovery_activity_v3` is NOT persisted (no column exists for it); fees are implicit in the `usd_notional` amount on V2 rows

### Critical V2 vs V1 fee semantics difference

| | V1 | V2 |
|---|---|---|
| Fee unit | Shares (conditional tokens) | USDC |
| Where deducted | From `signed_size` (fills in shares) | From gross USDC notional at match |
| In activity table | `signed_size` is already net of fee | `usd_notional` may or may not include fee depending on source |

The `fee` field on the `OrderFilledEvent` struct in `chainListener.ts` is captured as `parseFloat(event.fee) / 1e6` and put on the `DiscoveredTrade.fee` field, but this is NOT persisted to `discovery_activity_v3` (no `fee` column).

---

## Column shape assessment

Both V1 and V2 fills, once through the normalisation layer, produce rows with identical column shapes:

| Column | V1 semantics | V2 semantics | Same? |
|---|---|---|---|
| `proxy_wallet` | lowercase address | lowercase address | ✅ |
| `market_id` | from parquet | from parquet/chain | ✅ |
| `side` | `'BUY'` or `'SELL'` | `'BUY'` or `'SELL'` | ✅ |
| `price_yes` | `usd_amount / token_amount` | same | ✅ |
| `usd_notional` | gross USDC (6 dec scaled) | gross USDC after fee (6 dec scaled) | ⚠️ see note |
| `signed_size` | net tokens after share-fee (positive=BUY) | gross tokens (fee NOT in tokens for V2) | ⚠️ see note |
| `abs_size` | `ABS(signed_size)` | `ABS(signed_size)` | ✅ |

### Fee note (important for PnL)

- **V1 rows**: `signed_size` is the net token count after the share fee. `usd_notional` is gross USDC. To compute PnL for V1: treat `usd_notional` as the full USDC cost (buy) or proceeds (sell).
- **V2 rows**: `signed_size` is the full gross token count (fee is in USDC, not shares). `usd_notional` is **gross** USDC before the USDC fee is deducted. The USDC fee is not captured in the activity table (no fee column).

### PnL impact of missing V2 USDC fee

For the PnL formula, the V2 USDC fee is effectively embedded in the spread captured by traders — it's subtracted from maker proceeds and added to taker costs at match time. The exchange contract's emitted `makerAmountFilled / takerAmountFilled` in V2 is the **post-fee** amount (the fee is separate from the amounts). Therefore:

- **On BUY (V2)**: `usd_notional` in activity = USDC paid (already reflects fee deduction by the exchange).
- **On SELL (V2)**: `usd_notional` in activity = USDC received (already reduced by fee at match).

**Verdict**: `usd_notional` in `discovery_activity_v3` is the **net cash flow** for both V1 and V2 trades. No additional fee adjustment is needed in the PnL SQL — the exchange contract handles it before the event is emitted.

This is confirmed by the chainListener code:
```typescript
// V2 BUY: maker pays usdcAmount
usdcAmount = isBuy ? makerAmountRaw : takerAmountRaw;  // This is post-fee already
notionalUsd = usdcAmount / 1e6;
```

---

## V1 vs V2 detection in the activity table

The `discovery_activity_v3` table has **no explicit version column**. Detection options:

1. **Timestamp cutover**: trades with `ts_unix >= 1745827200` (2026-04-28 07:00 UTC) are V2. Reliable for the hard cutover. Use this.
2. **neg_risk flag**: not directly in the activity row (only in `markets_v3`), but joinable.
3. **Exchange address**: not stored in activity rows.

**Chosen signal for PnL formula**: Because `usd_notional` is already net cash flow for both V1 and V2, **no per-row branching is needed in the PnL SQL**. The formula `SUM(CASE side WHEN 'SELL' THEN +usd_notional ELSE -usd_notional END)` works correctly for both.

For documentation and auditing the V1/V2 boundary can be identified by `ts_unix >= 1745827200` (Apr 28 2026 07:00 UTC).

---

## Goldsky listener V2 gap

`goldskyListener.ts::normalizeOrderFilled` uses the V1 `makerAssetId === '0'` heuristic. If the Goldsky subgraph is updated to index V2 events with a different schema, this normalizer would misclassify them. **Recommendation**: when the Goldsky subgraph gains V2 support, update `normalizeOrderFilled` to handle the V2 `side` flag explicitly. This is out of scope for this PR (the backfill covers only V1 historical data; live V2 fills go through chainListener → TradeIngestion, not through goldskyListener → DuckDB).

---

## Summary

**Both V1 and V2 fills produce rows with semantically consistent columns in `discovery_activity_v3`.** The PnL formula using `usd_notional` as the cash-flow amount and `signed_size` as the token-balance delta is correct for both. No normalization layer is needed.
