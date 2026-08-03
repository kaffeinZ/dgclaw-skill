# Pre-registration — dgclaw signal harness

**Written 2026-08-02, BEFORE any harness code or data.** Nothing below may be changed
after the first row is logged. If it is changed, the analysis becomes exploratory and
must be labelled as such.

## 0. Prior

Five confident causal stories about this strategy dissolved under measurement in one
session. The stated prior is that **no predictor tested here has edge**. The harness is
built to be capable of returning that answer, not to find a reason to keep trading.

## 1. What is logged — every candidate, every scan

Not just gate-passers. The scanner already scores all ~110 universe assets to sort them;
logging one and discarding 109 is what makes the `score >= 60` gate untestable.

Per row: `ts, symbol, direction, score, rsi, obvRising, volumeBuildRatio, vwapDistPct,
ma50, ma200, isCross, oiUsd, oiDeltaPct, funding, midPrice, szDecimals`.

**No forward prices at log time.** Outcomes are computed later from candles.
~10,000 rows/day, ~1MB/day.

## 2. Outcomes — computed retrospectively

Forward return from `midPrice` at `ts`, per horizon, from 15m candles.
**Direction-signed**: for a short candidate, return is negated, so positive always means
"the signal was right."

**HARD DEADLINE: candleSnapshot retains 45 days.** Any row not backfilled by then is
permanently lost. The backfill runs as a scheduled job (daily cron), not a manual step.
Harness ships with the backfill or it does not ship.

**This is a permanent operating condition, not a start-up one.** Shipping the cron covers
day one; what destroys the study is silent failure at week six — cron erroring, the
outcome pass falling behind, an API shape change — with rows ageing out unnoticed. So the
backfill emits a **staleness metric every run**: age in days of the oldest row still
lacking an outcome, plus counts pending and computed. It logs `BACKFILL_STALE` at error
level once that age exceeds **30 days**, leaving 15 days of headroom to intervene.
Detect before the loss, not after it — the pattern that has held all session.

## 3. Predictors — pre-specified, no additions later

1. `score` (the composite, continuous across its full range — this is the primary)
2. `oiDeltaPct` interacted with contemporaneous price change (positioning: new money vs covering)
3. `funding` — **continuous cross-sectional**, not an extreme-event trigger. All 110
   values every scan; the tail is irrelevant to its use as a predictor.
4. Individual components (`rsi`, `obvRising`, `volumeBuildRatio`, `vwapDistPct`) — secondary,
   to test whether any part carries the composite.

**Dropped: liquidation mean-reversion.** No data source. REST returns 422 on all
liquidation endpoints; the WS `trades` channel carries no liquidation marker (verified
2026-08-02, 137 trades, keys `coin hash px side sz tid time users`). Inferring it from
the counterparty address is a separate identification project. Not in this registration.

**Not a predictor: maker-only entry.** It is an execution change, not a signal, and it
carries a selection effect — maker orders fail to fill precisely on fast moves, which may
be the moves that pay. Must be tested as its own experiment with fill/no-fill recorded.

## 4. Horizons

**6h, 24h, 48h.** Fixed now. Chosen to bracket the 29h median hold. No re-cutting to find
a horizon that works — re-cuts are exploratory and labelled so.

## 5. Inference spec — the part that makes or breaks this

**10,000 rows/day are not 10,000 observations.** Two dependencies collapse it:
15-minute sampling against a 24h horizon means consecutive rows share 95/96 of their
measurement window; and 110 crypto assets at one timestamp are one market move with 110
betas on it. Treated naively, **51% on a single day returns p<0.05** — that is an hour
when the market went up, not an edge.

```
naive (rows independent)      n=10560   SE=0.49pp   51.0% "significant"
cluster by timestamp          n=   96   SE=5.10pp   needs 60.0%
non-overlapping 24h blocks    n=    1
```

**Therefore, mandatory:**

1. **Cross-sectional demeaning.** Every row's predictor and outcome are demeaned against
   the cross-sectional mean at their own timestamp. This strips the common market factor
   and changes the question from "does score predict returns" (mostly: did crypto rise)
   to "does score rank assets against each other" — the only version that is an edge, and
   the one a long/short book harvests.
2. **Fama-MacBeth.** Per timestamp `t`, regress demeaned forward return on demeaned
   predictor across the cross-section to get `beta_t`. Test the time series of `beta_t`.
   This handles cross-sectional correlation by construction.
3. **Newey-West standard errors** on the `beta_t` series, lag = horizon / scan interval
   (24h horizon at 15min = **lag 96**). This is what corrects the overlapping windows.
4. **Block bootstrap by calendar day** (block length 1 day, 10,000 resamples) as a
   robustness check. Report both; disagreement between them is itself a finding.
5. **Report effective n explicitly** in every result: number of timestamps, number of
   days, and the Newey-West lag used. A result quoted without these is not reportable.
6. **MINIMUM-T CONDITION — a result below it is not reportable at any p-value.**
   Newey-West at long lags on a short series is unstable and can err in either direction,
   so the lag must stay small relative to `T`. Required: **T / lag >= 20**.

   | horizon | NW lag | min T | calendar days at 96 scans/day |
   |---|---|---|---|
   | 6h  | 24  | 480  | 5 days |
   | 24h | 96  | 1920 | 20 days |
   | 48h | 192 | 3840 | 40 days |

   **Consequence, accepted in advance:** at a 6-week run (~4032 timestamps) the 48h
   horizon only just clears its minimum, and rows logged in the final 48h have no
   outcome — so 48h may end the study **unreportable**. That is an accepted outcome,
   not a reason to relax the condition or extend the run after seeing results. For the
   48h horizon the **block bootstrap is primary**, since it needs no HAC bandwidth.

   The first week of output will look like a result and will not be one. It may be
   inspected for pipeline health only, never against section 7.

## 6. Multiplicity

4 predictor families x 3 horizons = 12 tests.

- **PRIMARY, single test:** `score` at **24h**. Threshold **alpha = 0.05**.
- **All others: secondary**, Bonferroni-corrected to **alpha = 0.05/12 = 0.0042**.
- Anything not in section 3 is **exploratory** and may not be reported as significant
  under any threshold. It generates a hypothesis for a *new* pre-registration.

**WHY there is exactly one primary test — read this before negotiating with the number.**
In roughly three weeks the primary will most likely be null while some secondary sits near
p=0.02, and there will be real pressure to promote it. That threshold is the only thing
standing there, and a future reader who sees a bare number will argue with it, so the
reason is written here instead.

Twelve tests at alpha=0.05 give a **46% chance of at least one false positive** under pure
noise. This is not hypothetical for this project: on 2026-08-02 roughly fifteen analyses
produced exactly one result at p=0.0436, it was briefly believed, and it dissolved under
censoring and measurement-asymmetry correction. **That p-value was the 54% arriving on
schedule.** A secondary at p=0.02 three weeks from now is the same event wearing better
clothes. Bonferroni is not conservatism, it is the price of having looked twelve times.

A secondary that clears 0.0042 is still only a hypothesis (see section 7) — it earns a new
pre-registration and fresh data, never a trading change on the data that generated it.

## 7. Decision rules — fixed in advance

| Result | Action |
|---|---|
| Primary significant, correct sign | Size the effect. Only then consider trading changes. |
| Primary null, a secondary passes Bonferroni | Treat as hypothesis, not finding. New pre-registration, fresh data. |
| All null | **Report that the strategy has no measurable edge.** This is a real answer and the most likely one. |
| Primary significant, wrong sign | Do NOT invert. Same error the session already made. New pre-registration. |

## 8. Stopping rule

Run to a **fixed calendar duration of 6 weeks** from first logged row, or until the
45-day retention forces the first backfill loss, whichever is sooner. **No interim
peeking against the decision thresholds** — descriptive monitoring of row counts and
backfill health only. Stopping early because a result looks good is what makes a
pre-registration worthless.

## 9. What this cannot do

It measures whether these predictors rank assets. It cannot measure the `score >= 60`
gate's value in isolation from the trading rule, cannot recover liquidation effects, and
cannot tell you whether a strategy would have been profitable after slippage and fees —
only whether the signal contains information. Profitability is a separate question that
requires an execution model.

---

## Amendment log

Amendments are legitimate **only while zero rows are logged** (section 0 freeze condition).
Each entry records the change, the reason, and confirms it was made pre-data.

**A1 — 2026-08-02, pre-data (signals.jsonl did not exist).**
Section 5's minimum-T calendar table assumed **96 scans/day**. Measured reality is
**10.5/day**: the scanner returns before scoring whenever the book is at max positions,
which is **97.4% of runs** (7531 of 7731). At that rate the 24h primary needs 183 days,
not 20, and could not conclude inside the study window. Amendment is contingent on the
scanner being changed to score the universe every run; **if that change is not made, this
pre-registration is void** — the study cannot reach its primary test.

**A2 — 2026-08-02, pre-data.** Storage cap set at **350 MB** (~8–12 months at measured
66 bytes/record gzipped), derived from the 6-week study requirement rather than chosen.
Eviction is oldest-first, which would silently truncate the earliest timestamps of the
Fama-MacBeth beta series. Therefore: **archives inside the study window are never evicted**
— the cap yields to study integrity and logs `CAP_BLOCKED` for an operator instead. Any
eviction that does occur is appended to `harness/EVICTIONS.log` and forms part of the
study record, so sample truncation can never be invisible in the results.
