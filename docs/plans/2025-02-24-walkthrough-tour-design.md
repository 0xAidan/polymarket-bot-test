# Walkthrough Tour — Design (Option 2: Overlay-only, no data replacement)

**Date:** 2025-02-24  
**Status:** Design approved — safe overlay-only implementation

---

## 1. Goal

- **First-time or any user:** Can start an interactive, in-UI walkthrough from **Help → Start walkthrough**.
- **Behavior:** Tour is a **visual overlay** on top of the existing app. We **never replace or hide** the user’s real data. No API interception, no fixture data, no swapping state.
- **Scope:** Explain each tab and main controls; easy to follow (Next/Back) and easy to skip (Skip). Re-enterable anytime from Help.

---

## 2. What we are NOT doing (safety)

- **No API layer changes.** We do not wrap, patch, or intercept `API.get*` / `API.post*`. All data stays from the real backend.
- **No demo/fixture data.** We do not inject fake wallets, trades, or balances. The user always sees their real UI state.
- **No modification of core app state.** We do not change `currentTab`, wallet lists, or any app state for tour purposes. The tour can *call* existing functions (e.g. `switchTab`) to show the right tab, but it does not replace or own that state.
- **No persistence of tour state in critical paths.** Optional: store “user dismissed tour” or “tour completed” in `localStorage` for UX only. No tour flag is used in API or business logic.

This keeps the risk surface minimal: if something breaks, it is either in the overlay or in the one place we hook into the app (Help menu + optional data attributes).

---

## 3. How the tour works

- **Overlay:** A single overlay (e.g. a full-screen div) that:
  - Renders a semi-transparent backdrop (optional dimming).
  - Has a “spotlight” or highlight region that frames the relevant part of the UI (e.g. a tab, a panel).
  - Shows a small **step card** (title, short description, [Back] [Next] [Skip]) that does not cover the highlighted area.
- **Steps:** A fixed list of steps. Each step defines:
  - **Target:** A DOM element to highlight (by selector or by `data-tour` id).
  - **Tab (optional):** If the step is for another tab, the tour calls the existing `switchTab(name)` so that tab is visible, then highlights the target.
  - **Copy:** Title and 1–2 sentences for that step.
- **Navigation:** Next → next step (and switch tab if needed); Back → previous step; Skip / Finish → close overlay and remove all tour DOM and listeners.
- **Entry:** Only from **Help → Start walkthrough**. No auto-start on first load (avoids surprising the user and keeps logic simple).

When the tour is closed, the page is exactly as before: same tab, same data, no leftover state.

---

## 4. Safety and maintainability

### 4.1 Isolated tour code

- **Single place for tour logic:** All tour behavior lives in dedicated files, e.g.:
  - `public/js/tour.js` — steps config, overlay creation, Next/Back/Skip, calling `switchTab` only when needed.
  - `public/styles/tour.css` (or a `tour` block in an existing stylesheet) — overlay, backdrop, step card, spotlight. Use a single class prefix (e.g. `tour-`) so tour styles don’t leak.
- **Any bug that only appears when the tour is visible** should be traceable to these files. Grep for `tour` or the tour filename to find every touch point.

### 4.2 Minimal touch surface in the rest of the app

- **index.html:** Add one `<script src="/js/tour.js">` and, if used, one `<link>` for tour CSS. Order: load tour after `app.js` so `switchTab` and DOM exist.
- **app.js:** Add a single Help menu item: **Start walkthrough** whose action calls a function exposed by the tour (e.g. `window.startTour()` or `Tour.start()`). No other app logic should depend on “tour active” or any tour state.
- **DOM:** Prefer **data attributes** for targets (e.g. `data-tour="dashboard-tab"`, `data-tour="wallets-panel"`). Add these only where we need a stable hook for the spotlight. If a selector breaks after a layout change, we only update the step config in `tour.js`, not core markup.

### 4.3 No branching of core paths

- **Data loading:** `loadAllData`, `loadWallets`, `loadTrades`, etc. are unchanged. They are never passed a “tour mode” or “use fixtures” flag.
- **API:** No wrapper, no “if tour then return demo data.” All requests go to the real backend.
- **Rendering:** Existing functions that fill the UI (e.g. trade table, wallet list) are not modified. The tour only adds a layer on top.

### 4.4 Feature kill switch

- **Constant in tour.js:** e.g. `const TOUR_ENABLED = true;`. If the tour causes issues, set to `false`: the Help item can check this and do nothing (or hide the menu item), and the rest of the app is unaffected. No need to remove script tags or revert large changes.

### 4.5 Traceability when something breaks

- **Tour-related bug:** Search for `tour`, `tour.js`, or `data-tour`. Only those files and attributes are involved. No need to search API or data-loading code.
- **Bug only when tour is open:** Isolate in tour.js (overlay, focus, z-index, or `switchTab` timing). If we need to call `switchTab`, call it once per step and rely on existing behavior.
- **Bug after closing tour:** Tour teardown must remove all added nodes and event listeners. If something persists (e.g. invisible overlay blocking clicks), the bug is in tour teardown in tour.js.

---

## 5. Implementation outline

- **tour.js**
  - Define steps (target selector or `data-tour`, tab name if needed, title, description).
  - Export `startTour()`: create overlay, backdrop, step card, highlight element; bind Next/Back/Skip; first step.
  - On Next/Back: update step index, call `switchTab` if step’s tab differs from current, move highlight to new target, update card copy.
  - On Skip/Finish: remove overlay and all tour DOM, remove any listeners added by the tour (e.g. on overlay buttons only). Do not alter app state.
  - If `TOUR_ENABLED` is false, `startTour()` returns immediately.
- **tour.css**
  - Styles for overlay, backdrop, step card, spotlight (e.g. outline or cutout). All under a single prefix (e.g. `.tour-overlay`, `.tour-card`, `.tour-spotlight`).
- **index.html**
  - Add `<link rel="stylesheet" href="/styles/tour.css">` (or equivalent) and `<script src="/js/tour.js">` after app.js.
- **app.js**
  - In `toggleHelpMenu`, add item: `{ label: 'Start walkthrough...', action: () => { if (typeof startTour === 'function') startTour(); } }`. Do not add any other tour logic.
- **Optional:** Add `data-tour="..."` to a small set of elements (tabs, main panels) so the tour can target them reliably. Prefer IDs or stable classes already present; add `data-tour` only where necessary.

---

## 6. Rollback and disable

- **Disable without code revert:** Set `TOUR_ENABLED = false` in tour.js. Help menu can still call `startTour()` but it no-ops; no overlay, no side effects.
- **Full rollback:** Remove the Help menu item, remove the script and link for tour, remove any `data-tour` attributes. The app behaves exactly as before the feature. No API or data-flow changes to revert.

---

## 7. Summary

- **Option 2:** Overlay-only walkthrough; user always sees their real data; no API or data replacement.
- **Safety:** Tour is additive and isolated; no changes to API, loaders, or core state; single place to look for tour bugs; feature flag and simple rollback.

Next step: implementation plan (file-by-file tasks and testing checklist).
