# Discovery Platform Research Report

**Date:** 2026-04-14  
**Project:** Polymarket discovery platform overhaul  
**Purpose:** Source-backed research companion to `docs/plans/2026-04-14-discovery-platform-master-plan.md`

---

## 1. Research Goal

This report answers four questions:

1. What should a strong Polymarket wallet discovery product actually do?
2. What data can we obtain cheaply enough to support it?
3. How should we identify genuinely valuable wallets versus lucky, manipulative, or uncopyable ones?
4. How do we validate that the system is useful instead of just impressive-looking?

---

## 2. Big Conclusions

### Conclusion 1

The core opportunity is not “more analytics.” It is a **decision system** for finding and acting on wallets early.

### Conclusion 2

The best low-cost foundation is **Polymarket-native**:

- Gamma API
- Data API
- selective CLOB reads
- optional public subgraph support

### Conclusion 3

Wallet discovery must separate:

- **forecasting/informational quality**
- **economic profitability**
- **copyability**
- **integrity/trust**
- **strategy type**

### Conclusion 4

Evaluation is not optional. Without point-in-time walk-forward evaluation, the product will almost certainly overrate hindsight and noise.

---

## 3. Official Polymarket Data Research

## 3.1 Data Surfaces

| Surface | What it provides | Best use |
|---|---|---|
| Gamma API | markets, events, tags, slugs, metadata | build market universe |
| Data API | positions, trades, activity, holders, leaderboard | wallet discovery and wallet context |
| CLOB REST / WS | book state, prices, spreads, trade freshness | microstructure and copyability |
| Public subgraph | on-chain history and corroboration | analytics and backfill |

### Main takeaway

Polymarket already exposes enough structured public data that we do **not** need to rebuild a generic chain-indexing company to ship a strong first version.

### Source links

- [Polymarket API introduction](https://docs.polymarket.com/api-reference/introduction)
- [Polymarket market data overview](https://docs.polymarket.com/market-data/overview)
- [Polymarket fetching markets](https://docs.polymarket.com/market-data/fetching-markets)
- [Polymarket subgraph docs](https://docs.polymarket.com/market-data/subgraph)

---

## 3.2 Rate Limits and Operational Constraints

### Important findings

- Data API is powerful but not infinite.
- Polling must be disciplined.
- CLOB and Gamma give strong supporting context, but they do not automatically solve wallet ranking.
- Public endpoints are enough for a serious baseline if requests are budgeted carefully.

### Source links

- [Polymarket rate limits](https://docs.polymarket.com/api-reference/rate-limits)
- [Polymarket changelog](https://docs.polymarket.com/changelog)

---

## 3.3 Cheap Infrastructure Reality

### Practical cost ladder

| Layer | Cost posture | Notes |
|---|---|---|
| Polymarket public APIs | effectively free | constrained by throttling and architecture, not invoice |
| Goldsky public subgraph access | very low / free baseline | useful for backfill and corroboration |
| Small worker + SQLite / low-cost DB | low | suitable for baseline |
| Heavy raw chain logs | can get expensive | avoid as the core path |
| Paid RPC / social enrichment | optional future | only add if measured lift justifies it |

### Source links

- [Goldsky Polymarket chain page](https://goldsky.com/chains/polymarket)
- [The Graph pricing](https://thegraph.com/studio-pricing/)
- [Alchemy free tier details](https://www.alchemy.com/support/free-tier-details)
- [Alchemy pricing](https://www.alchemy.com/pricing)

---

## 4. Competitive and Market Research

## 4.1 Product Buckets

| Bucket | What it gets right | What it gets wrong |
|---|---|---|
| Leaderboards | simple and addictive | overweights vanity metrics |
| Whale trackers | fast and attention-grabbing | often noisy, shallow, or hard to trust |
| Analytics terminals | powerful browsing and search | often data-rich but decision-poor |
| Smart-money platforms | strong labeling and trust framing | overbuilt for a Polymarket-first product |
| Copy-trading tools | clear action path | often weak on discovery and verification |

### Source links

- [Polymarket Analytics](https://polymarketanalytics.com/)
- [Hashdive](https://www.hashdive.com/)
- [PredictionSync](https://www.predictionsync.com/)
- [Nansen Smart Money](https://docs.nansen.ai/api/smart-money)
- [Arkham tagging guide](https://info.arkm.com/research/a-guide-to-arkham-intels-industry-leading-tagging-system)

---

## 4.2 What Existing Products Suggest

### Strong recurring features

- searchable wallet pages
- category filters
- watchlists
- alerts
- simple scores/badges
- ranked views
- market pages with top holders

### Missing pieces

- strong copyability framing
- deep trust logic
- strong explanation layer
- clean separation of strategy types
- disciplined evaluation and methodology visibility

---

## 5. Prediction Market and Microstructure Research

## 5.1 Markets as Forecast Systems

Prediction markets can aggregate information well, but that does **not** mean every profitable actor is a strong forecaster.

### Source links

- [Prediction Markets overview (Wolfers and Zitzewitz)](https://pubs.aeaweb.org/doi/pdfplus/10.1257/0895330041371321)
- [Berg, Nelson, Rietz on market accuracy](https://www.sciencedirect.com/science/article/abs/pii/S0169207008000320)

---

## 5.2 Informed Trading and Price Impact

### Key idea

Informed traders often matter because of how their orders move prices, not just because their PnL looks good later.

### Product implication

The discovery system should care about:

- timing,
- price impact,
- persistence,
- whether the wallet seems to lead meaningful moves.

### Source links

- [Price formation in field prediction markets](https://www.sciencedirect.com/science/article/pii/S1386418123000794)
- [Kyle model lecture notes](http://home.cerge-ei.cz/petrz/fm/f400n30.pdf)

---

## 5.3 Manipulation and Wash Trading

### Key idea

Manipulation can sometimes get corrected, but sometimes it persists long enough to distort a product that blindly trusts volume or leaderboard metrics.

### Product implication

Discovery must include:

- trust suppression,
- suspicious behavior flags,
- anti-wash logic,
- market-context sensitivity.

### Source links

- [Manipulation and information aggregation working paper](https://hanson.gmu.edu/biashelp.pdf)
- [Manipulation field experiment summary](https://ideas.repec.org/p/arx/papers/2503.03312.html)
- [Polymarket wash-trading SSRN paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5714122)
- [Crypto wash trading paper](https://doi.org/10.1287/mnsc.2021.02709)

---

## 5.4 Structural Arbitrage

### Key idea

Some of the most profitable Polymarket actors may be exploiting structural inconsistencies rather than forecasting better than everyone else.

### Product implication

This is valuable behavior, but it should not be mixed with “best directional wallets.”

### Source link

- [Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets](https://arxiv.org/abs/2508.03474)

---

## 6. Ranking and Trust Research

## 6.1 Why One Score Is Not Enough

If one score tries to express everything, it will become untrustworthy.

### Better approach

Use separate layers:

- discovery,
- trust,
- copyability,
- confidence,
- strategy class.

---

## 6.2 Small Samples and Shrinkage

### Key idea

A few wins should not let a wallet dominate the feed.

### Product implication

Use:

- minimum sample thresholds,
- shrinkage toward cohort means,
- stronger confidence penalties for short histories.

### Source links

- [Empirical Bayes shrinkage lecture notes](https://ryansbrill.com/pdf/statistics_in_sports_papers/Brill_summerLabLecture_empiricalBayes.pdf)
- [Deflated Sharpe Ratio paper](https://papers.ssrn.com/abstract=2460551)

---

## 6.3 Explainability

### Key idea

Explanations are required for calibrated trust.

### Product implication

Every surfaced wallet should have:

- primary reason,
- supporting evidence chips,
- confidence indicator,
- methodology link,
- low-data or risk flags when appropriate.

### Source links

- [Google PAIR explainability and trust](https://pair.withgoogle.com/chapter/explainability-trust/)
- [PAIR patterns](https://pair.withgoogle.com/guidebook/patterns)
- [NIST explainable AI principles](https://doi.org/10.6028/NIST.IR.8312)

---

## 7. UX and Product Design Research

## 7.1 Best Surface Types

| Surface | Why it matters |
|---|---|
| Discovery feed | attention-first, reasons-first |
| Dense leaderboard table | scan, sort, compare |
| Wallet profile | trust and strategy evaluation |
| Compare view | support side-by-side decisions |
| Watchlist | monitoring loop |
| Alerts center | time-sensitive follow-up |
| Methodology | trust and transparency |

### Source links

- [NN/g data tables](https://www.nngroup.com/articles/data-tables/)
- [NN/g comparison tables](https://www.nngroup.com/articles/comparison-tables/)
- [Baymard list item design](https://baymard.com/blog/list-item-design-ecommerce)
- [Apple managing notifications](https://developer.apple.com/design/human-interface-guidelines/managing-notifications)

---

## 7.2 Confidence and Explanation UX

### Recommendation

Prefer:

- low/medium/high confidence,
- evidence count,
- freshness,
- “why this surfaced,”
- “what would make this stronger.”

Avoid:

- fake-precision percentages with weak statistical meaning.

---

## 7.3 Watchlist and Alerts

### Recommendation

The watchlist should be persistent and user-owned. Alerts should be:

- budgeted,
- deduplicated,
- severity-aware,
- easy to mute or downgrade.

### Source links

- [eBay watchlist help](https://www.ebay.com/help/buying/search-tips/watchlist?id=4046)
- [Material snackbars](https://m3.material.io/components/snackbar/guidelines)

---

## 8. Internal Repo Research

## 8.1 Most Important Architecture Finding

There are effectively two different discovery systems in the repo with overlapping purpose and different semantics.

### Implication

The rebuild should unify runtime and data contract before trying to polish the UI or retune scores.

---

## 8.2 Major Risks Found in Current Code

| Risk | Why it matters |
|---|---|
| split scoring paths | contradictory truth in UI and storage |
| hidden metric semantics | trust erosion and debugging difficulty |
| partial live signal wiring | false sense of sophistication |
| multiple worker paths | operational confusion |
| old and new discovery models coexisting | migration complexity |

---

## 8.3 Most Valuable Existing Assets

- existing discovery tests,
- existing schema scaffolding,
- existing scoring components,
- discovery UI foothold,
- prior vision docs.

That means the project is a rebuild, not a greenfield invention.

---

## 9. Recommended Research-to-Plan Translation

### Product decisions

- discovery-first
- Polymarket-native
- nearly-free core
- explanation-first
- trust-first
- strategy-aware

### Technical decisions

- one runtime model
- v2 schema
- point-in-time features
- layered score stack
- walk-forward evaluation
- cost telemetry

### UX decisions

- discovery feed
- leaderboard
- wallet profile
- compare
- watchlist
- alerts center
- methodology page

---

## 10. Open Constraints

These are not blockers, but they need to stay visible:

- the free core architecture must remain the default,
- social/X enrichment should stay optional and weakly coupled,
- raw chain infrastructure should remain a fallback rather than the product center,
- the migration must preserve stability in the rest of the app.

---

## 11. Final Research Position

The research strongly supports a **large, deliberate rebuild** rather than incremental patching.

The evidence points to a product that should be:

- wallet discovery first,
- trust-aware,
- point-in-time honest,
- operationally cheap,
- explainable by default,
- integrated tightly with the existing copy-trading engine.

That is the right scope for the next major evolution of the app.
