# Discovery UI Spec

**Date:** 2026-04-14  
**Parent plan:** `docs/plans/2026-04-14-discovery-platform-master-plan.md`  
**Purpose:** Define the product surfaces, page structure, interaction model, and visual information hierarchy for the rebuilt discovery experience.

---

## 1. Goal

Translate the discovery engine into a UI that helps a non-technical user:

1. notice valuable wallets quickly,
2. understand why they surfaced,
3. judge whether they are trustworthy,
4. decide whether to watch or track them.

The UI should feel like an operating surface, not an academic dashboard.

---

## 2. Design Principles

### Principle 1: Reasons before raw numbers

Users should see “why this matters” before they are forced to interpret metrics.

### Principle 2: Simple scan, deeper drill-down

The first layer should be fast to scan. Details should be available without overwhelming the feed.

### Principle 3: Scores must be legible

If the system shows discovery, trust, and copyability, the user should immediately understand that they mean different things.

### Principle 4: Confidence and caution are first-class

The UI should never imply false certainty.

### Principle 5: Actions should be near insight

`Watch` and `Track` should live next to the reason a wallet surfaced.

---

## 3. Navigation Model

## Discovery navigation stack

| Page | Primary purpose |
|---|---|
| Discovery Home | “What deserves attention right now?” |
| Leaderboard | ranked browsing and filtering |
| Wallet Profile | trust and strategy decision page |
| Compare | side-by-side wallet evaluation |
| Watchlist | saved wallets and active monitoring |
| Alerts Center | time-sensitive updates |
| Methodology | explanation of scores and caveats |

## Suggested app placement

The current Discovery tab becomes a gateway into these surfaces rather than one oversized page.

---

## 4. Page Specs

## 4.1 Discovery Home

### Purpose

The “attention layer.” This is the best place to start the user every time they visit discovery.

### Core modules

| Module | Purpose |
|---|---|
| Filter bar | control category, window, trust, copyability |
| Attention summary | top-level counts and freshness |
| Discovery feed | surfaced wallets with reasons |
| Market pulse | optional compact context about where action is happening |
| Watchlist updates | what changed in followed wallets |

### Information hierarchy

1. page title and freshness
2. filters
3. surfaced wallets
4. secondary summaries

### Discovery card content

Each card should show:

- wallet identity
- strategy badge
- discovery / trust / copyability summaries
- primary reason sentence
- up to three supporting chips
- one caution chip if needed
- actions: `View`, `Watch`, `Track`

### Wallet identity rule

When a wallet has no readable Polymarket username or pseudonym, the UI should generate and display a stable fallback alias instead of leading with a raw wallet address.

#### Requirements

- use a random-animal style alias,
- keep the alias deterministic for that wallet,
- still expose the underlying address on hover, detail view, and copy actions,
- never hide the true address completely.

#### Example aliases

- `Silver Otter`
- `Blue Falcon`
- `Quiet Panther`

### Mockup

```text
+----------------------------------------------------------------------------------+
| Discovery Home                                                                  |
| Last updated 2m ago                                                             |
| [Emerging] [Politics] [7d] [Copyable only] [High trust]                         |
+----------------------------------------------------------------------------------+
| Silver Otter  Informational directional                                        |
| Discovery 86   Trust 72   Copyability 81   Confidence Medium                    |
| Early entry before broad politics volume accelerated                            |
| Chips: Category specialist | Repeat timing | Above-cohort conviction            |
| Caution: Thin-liquidity markets in recent sample                                |
| [View] [Watch] [Track]                                                          |
+----------------------------------------------------------------------------------+
| 0xBC...21      Structural arbitrage                                             |
| Discovery 79   Trust 88   Copyability 34   Confidence High                      |
| Repeated parity capture across related markets                                  |
| Chips: Stable returns | High trust | Strategy-specific edge                     |
| Caution: Not a default copy target                                              |
| [View] [Watch]                                                                  |
+----------------------------------------------------------------------------------+
```

### Key states

| State | Behavior |
|---|---|
| Loading | show skeleton rows/cards |
| Empty | explain that no wallets match current filters |
| Low confidence feed | show banner that current surfaced wallets are provisional |
| Stale data | show freshness warning prominently |

---

## 4.2 Leaderboard

### Purpose

The dense browsing and sorting page.

### Recommended desktop-first layout

Use a table, not cards, as the primary desktop presentation.

### Columns

| Column | Notes |
|---|---|
| Wallet | sticky first column; use readable alias when no username exists |
| Strategy | compact badge |
| Discovery | sortable |
| Trust | sortable |
| Copyability | sortable |
| Confidence | bucketed |
| Category focus | compact text |
| Primary reason | shortened text |
| Actions | `View`, `Watch`, `Track` |

### Controls

- category filter
- time window
- strategy filter
- copyability filter
- trust filter
- sort menu
- compare mode toggle

### Table behavior

- sticky headers,
- sticky wallet column,
- hover row highlight,
- row click opens profile,
- compare checkbox per row.

### Mockup

```text
+------------------------------------------------------------------------------------------------+
| Leaderboard                                                                                   |
| Filters: [All categories] [30d] [All strategies] [Trust > Medium] [Sort: Discovery]         |
+------------------------------------------------------------------------------------------------+
| Wallet      | Strategy      | Discovery | Trust | Copyability | Confidence | Why             |
| Silver Otter| Info          | 86        | 72    | 81          | Medium     | Early politics  |
| 0xBC...21   | Arb           | 79        | 88    | 34          | High       | Market parity   |
| 0x92...EF   | Momentum      | 74        | 58    | 66          | Medium     | Cohort follower |
+------------------------------------------------------------------------------------------------+
```

### Mobile adaptation

On smaller screens:

- collapse table into card-list form,
- preserve same core fields,
- keep compare mode optional and limited.

---

## 4.3 Wallet Profile

### Purpose

The trust and action page.

### Sections

| Section | Purpose |
|---|---|
| Header | identity, badges, actions |
| Score strip | discovery, trust, copyability, confidence |
| Why this matters | explanation-first summary |
| Strategy overview | what kind of wallet this is |
| Performance and behavior | windows, drawdown, cadence, concentration |
| Recent markets and trades | recent context |
| Risks and cautions | explicit caveats |
| Actions | watch, track, compare |

### Header requirements

- wallet identity
- first seen
- current strategy class
- current confidence bucket
- `Watch`, `Track`, `Compare` actions

If no readable username exists, the header should use the generated fallback alias first and show the raw address as supporting identity.

### “Why this matters” module

Must be visible above deep metrics.

### Example content

```text
Why this wallet matters
- Entered four politics markets before broad flow followed
- Sustained category focus over 30d
- Low suspicion score
- Follower-friendly average sizing

Caution
- Recent sample includes several thin markets
```

### Profile mockup

```text
+----------------------------------------------------------------------------------+
| Silver Otter                                                                     |
| Informational directional | First seen 31d ago | Confidence Medium               |
| Wallet: 0xA1...9F                                                                |
| [Watch] [Track] [Compare]                                                        |
+----------------------------------------------------------------------------------+
| Discovery 86 | Trust 72 | Copyability 81                                         |
+----------------------------------------------------------------------------------+
| Why this matters                                                                |
| - Entered politics markets early                                                |
| - Strong category specialization                                                |
| - Repeated timing quality                                                       |
| Caution: recent sample includes thin books                                      |
+----------------------------------------------------------------------------------+
| Strategy        | Performance        | Behavior         | Copyability            |
| Directional     | 7d / 30d / 90d     | Hold time        | Liquidity fit          |
|                 | Drawdown           | Bet size         | Slippage estimate      |
+----------------------------------------------------------------------------------+
| Recent markets and recent trades                                                |
+----------------------------------------------------------------------------------+
```

---

## 4.4 Compare View

### Purpose

Make it easy to choose among a small set of wallets.

### Rules

- compare 2 to 4 wallets,
- highlight differences,
- keep the attribute list fixed and consistent,
- keep actions available.

### Comparison categories

| Category | Fields |
|---|---|
| Identity | wallet, strategy, first seen |
| Scores | discovery, trust, copyability, confidence |
| Behavior | category focus, holding horizon, avg size |
| Risks | key caution flags |
| Recommendation | best fit for watch, best fit for copy |

### Mockup

```text
+------------------------------------------------------------------------------------------------+
| Compare Wallets                                                                               |
+------------------------------------------------------------------------------------------------+
| Attribute         | Wallet A         | Wallet B         | Wallet C                           |
| Strategy          | Informational    | Arb              | Momentum                           |
| Discovery         | 86               | 79               | 68                                 |
| Trust             | 72               | 88               | 54                                 |
| Copyability       | 81               | 34               | 63                                 |
| Category focus    | Politics         | Mixed            | Crypto                             |
| Best use          | Track            | Watch            | Conditional                        |
+------------------------------------------------------------------------------------------------+
```

---

## 4.5 Watchlist

### Purpose

The user’s saved monitoring surface.

### Key functions

- show watched wallets,
- show recent changes,
- allow alert preference control,
- allow promote-to-track actions.

### Columns or cards should include

- wallet,
- latest status,
- last notable event,
- trust/copyability snapshot,
- alert state,
- quick actions.

### Example states

- new notable trade
- trust changed
- strategy changed
- confidence improved
- caution increased

---

## 4.6 Alerts Center

### Purpose

A reviewable event stream, not just ephemeral popups.

### Alert categories

| Category | Example |
|---|---|
| Emerging wallet | new wallet surfaced |
| Trust change | wallet trust materially improved or dropped |
| Copyability change | wallet became easier or harder to copy |
| Watchlist event | watched wallet had a meaningful event |
| Caution event | suspicious or riskier behavior emerged |

### Severity

| Severity | Use |
|---|---|
| Informational | useful update, no urgency |
| Important | likely worth review |
| Critical | rare; should require corroborated criteria |

### Alert row contents

- time,
- wallet,
- headline,
- reason,
- quick actions,
- dismiss or mute options.

---

## 4.7 Methodology Page

### Purpose

Help users understand the system without forcing them to read dense technical docs.

### Sections

| Section | Purpose |
|---|---|
| What discovery means | explain emerging vs established |
| What each score means | discovery, trust, copyability, confidence |
| What the system can get wrong | caveats and limits |
| What strategy classes mean | interpret arb vs directional vs others |
| How to use the product | practical guidance |

### Tone

- plain language,
- direct,
- honest about limits,
- no overclaiming.

---

## 5. Components

## 5.1 Wallet Identity Chip

Contains:

- short address or label,
- optional pseudonym,
- optional category tag,
- optional strategy badge.

## 5.2 Score Strip

Displays:

- discovery,
- trust,
- copyability,
- confidence.

### Rule

These four should never be visually conflated as one thing.

## 5.3 Reason Stack

Contains:

- primary reason,
- supporting reason chips,
- caution chip.

## 5.4 Actions Cluster

Contains:

- `View`
- `Watch`
- `Track`
- optional `Compare`

---

## 6. Information Hierarchy

### Feed and leaderboard

1. identity
2. strategy
3. primary reason
4. score strip
5. confidence and caution
6. actions

### Profile

1. identity and actions
2. score strip
3. why this matters
4. risk and caution
5. deeper metrics
6. history and supporting context

---

## 7. Interaction Model

## 7.1 Main actions

| Action | Result |
|---|---|
| View | open wallet profile |
| Watch | add to watchlist |
| Track | promote to tracked-wallet flow |
| Compare | add to compare tray |
| Dismiss | remove from current view or mute |

## 7.2 Compare tray

As users select wallets to compare, show a persistent compare tray until they open compare or clear it.

## 7.3 Track flow

Tracking should feel like a direct continuation of discovery.

The user should not feel like they are moving into a completely different system.

---

## 8. States and Edge Cases

## 8.1 Empty states

| Surface | Example text direction |
|---|---|
| Discovery feed | no wallets currently match these filters |
| Leaderboard | try widening trust or category filters |
| Watchlist | save wallets to monitor them here |
| Alerts | no meaningful updates yet |

## 8.2 Low-confidence states

When a wallet is interesting but weakly supported:

- show it,
- label it as provisional,
- explain what is missing.

## 8.3 Stale-data states

If provider freshness is poor:

- show warning prominently,
- lower confidence presentation,
- avoid pretending the list is current.

## 8.4 Risk-heavy states

If a wallet is suspicious or structurally hard to copy:

- use caution styling,
- reduce prominence,
- keep `Watch` available before `Track` if appropriate.

---

## 9. Suggested Visual Language

### Color roles

Use color to support, not replace, text.

Suggested semantic roles:

- neutral: default scores and layout
- positive: strong trust or copyability
- caution: low confidence or structural complexity
- danger: suspicious or suppressed behavior

### Important rule

Do not rely on color alone. Pair every semantic color with:

- badge text,
- icon,
- or label.

---

## 10. Accessibility Rules

- table headers must be semantically correct,
- sticky columns should remain keyboard-usable,
- actions must be accessible by keyboard,
- badges and chips must not rely on color only,
- loading and stale states must be communicated to screen readers,
- confidence and caution language must be plain and specific.

---

## 11. Rollout Sequence

## Suggested rollout order

1. refreshed discovery feed
2. wallet profile
3. leaderboard refinement
4. compare
5. watchlist and alerts center
6. methodology page

This order keeps the first visible product improvement tightly coupled to the rebuilt engine.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| too many metrics overwhelm users | reasons-first layout |
| users misread scores as one unified truth | separate labels and descriptions |
| compare view gets cluttered | cap wallet count and attributes |
| alerts become spam | severity and budget rules |
| profile pages become dashboard soup | keep “why this matters” above analytics |

---

## 13. Final Recommendation

The discovery UI should be built as a **decision product**:

- feed to notice,
- profile to understand,
- compare to judge,
- watchlist to monitor,
- alerts to react,
- methodology to trust.

That structure gives the backend ranking system the best chance of being understandable and useful in practice.
