# Discovery Validation Notes

## Shadow Mode

- Compare the grouped opportunity feed against the legacy wallet table using `GET /api/discovery/summary?shadowMode=true`.
- Watch for meaningful drift in wallet counts, trust-level mix, and category concentration before making the card feed the only surface.

## Request Budget

- Inspect `GET /api/discovery/status` and review `apiPoller.requestBudget`.
- Current default budget is `200` tracked discovery requests per evaluation window snapshot.
- If `withinBudget` becomes `false`, treat that as a rollout blocker until the polling or verification load is reduced.

## Manual Smoke Checks

- Open the Discovery tab and confirm grouped opportunity cards render above the debug wallet table.
- Toggle `Verified Only` and confirm the feed tightens without breaking the fallback table.
- Open at least one wallet detail from a grouped card and confirm positions/signals still load.

## Cutover Criteria

- Shadow comparison stays directionally consistent over repeated runs.
- Request budget remains within limits during normal discovery operation.
- Grouped cards surface a balanced mix of categories, not a sports or crypto-dominated feed.
- Verified opportunities remain a meaningful subset of the surfaced feed instead of dropping to zero.
