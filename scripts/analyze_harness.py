#!/usr/bin/env python3
"""Analyse the signal harness per HARNESS-PREREG.md (frozen 2026-08-02, sha c82246c9).

WRITTEN 2026-08-06, BEFORE ANY RESULT EXISTED. That timing is the point: the analysis
code is the last place where seeing data could influence method. Built against a frozen
spec with no result in hand, the implementation choices cannot be a garden of forking
paths. If this file is materially changed after a result has been seen, the study becomes
exploratory and must be reported as such.

Read-only. Touches nothing the scanner uses.

    python3 scripts/analyze_harness.py
"""
import gzip, glob, json, math, os, random, sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVES = os.path.join(ROOT, "harness", "*.jsonl.gz")

SCAN_MINUTES = 15
HORIZONS = [6, 24, 48]                       # frozen
PRIMARY = ("score", 24)                      # single primary test
ALPHA_PRIMARY = 0.05
N_TESTS = 12
ALPHA_SECONDARY = 0.05 / N_TESTS             # 0.00417
MIN_T_OVER_LAG = 20                          # HAC stability floor
BOOT_RESAMPLES = 10_000
PREDICTORS = ["score", "rsi", "volumeBuildRatio", "funding", "oiDeltaPct", "vwapDistPct"]


def norm_cdf(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def two_sided_p(z):
    return 2.0 * (1.0 - norm_cdf(abs(z)))


def load():
    rows = []
    for f in sorted(glob.glob(ARCHIVES)):
        with gzip.open(f, "rt") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    return rows


def cross_sectional_betas(rows, predictor, horizon):
    """Fama-MacBeth stage 1.

    Within each timestamp, demean BOTH predictor and outcome across the cross-section,
    then regress. Demeaning strips the common market factor, which is what turns
    'does score predict returns' (mostly: did crypto move) into 'does score rank assets
    against each other' -- the only version that is an edge. It also handles the
    cross-sectional correlation of ~110 alts sharing one market beta, by construction
    rather than by correction.
    """
    key = f"r{horizon}h"
    by_ts = defaultdict(list)
    for r in rows:
        x, y = r.get(predictor), r.get(key)
        if x is None or y is None:
            continue
        if isinstance(x, bool):
            x = float(x)
        by_ts[r["ts"]].append((float(x), float(y)))

    betas, stamps = [], []
    for ts in sorted(by_ts):
        pts = by_ts[ts]
        if len(pts) < 10:                      # a cross-section too thin to regress
            continue
        mx = sum(p[0] for p in pts) / len(pts)
        my = sum(p[1] for p in pts) / len(pts)
        sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
        sxx = sum((p[0] - mx) ** 2 for p in pts)
        if sxx <= 0:                           # no variation in the predictor this scan
            continue
        betas.append(sxy / sxx)
        stamps.append(ts)
    return betas, stamps


def newey_west_se(betas, lag):
    """HAC standard error for the beta series.

    The lag is NOT a bandwidth choice -- it is forced by the overlap. Sampling every
    15 minutes against a 24h horizon means consecutive betas share 95/96 of their
    measurement window, so autocorrelation is mechanical out to `lag`.
    """
    T = len(betas)
    if T < 2:
        return float("nan")
    mb = sum(betas) / T
    dev = [b - mb for b in betas]
    g0 = sum(d * d for d in dev) / T
    s = g0
    for j in range(1, min(lag, T - 1) + 1):
        gj = sum(dev[t] * dev[t - j] for t in range(j, T)) / T
        s += 2.0 * (1.0 - j / (lag + 1.0)) * gj
    if s <= 0:                                 # NW can go negative on short series
        return float("nan")
    return math.sqrt(s / T)


def block_bootstrap(betas, stamps, resamples=BOOT_RESAMPLES, seed=0):
    """Resample whole CALENDAR DAYS with replacement.

    Needs no HAC bandwidth, so it stays valid where Newey-West becomes unstable. The
    pre-registration requires this be reported ALONGSIDE Fama-MacBeth every time --
    disagreement between them is itself a finding, and reporting only one lets the
    friendlier number win by default.
    """
    if not betas:
        return (float("nan"), float("nan"))
    by_day = defaultdict(list)
    for b, ts in zip(betas, stamps):
        by_day[ts // 86_400_000].append(b)
    days = list(by_day)
    if len(days) < 2:
        return (float("nan"), float("nan"))
    rng = random.Random(seed)
    means = []
    for _ in range(resamples):
        pool = []
        for _ in range(len(days)):
            pool.extend(by_day[days[rng.randrange(len(days))]])
        if pool:
            means.append(sum(pool) / len(pool))
    means.sort()
    lo = means[int(0.025 * len(means))]
    hi = means[min(int(0.975 * len(means)), len(means) - 1)]
    return (lo, hi)


def report(rows, predictor, horizon, is_primary):
    lag = int(horizon * 60 / SCAN_MINUTES)
    betas, stamps = cross_sectional_betas(rows, predictor, horizon)
    T = len(betas)
    days = len({t // 86_400_000 for t in stamps}) if stamps else 0

    label = f"{predictor} @ {horizon}h" + ("   [PRIMARY]" if is_primary else "")
    print(f"\n--- {label} ---")
    # Preconditions FIRST, and a refusal rather than a caveat. A caveat gets read past.
    print(f"    T={T} timestamps | days={days} | NW lag={lag} | T/lag={T/lag if lag else 0:.1f} "
          f"(floor {MIN_T_OVER_LAG})")
    if T == 0:
        print("    NOT REPORTABLE — no usable cross-sections.")
        return
    if T / lag < MIN_T_OVER_LAG:
        need = MIN_T_OVER_LAG * lag
        print(f"    NOT REPORTABLE — Newey-West at lag {lag} is unstable below T={need}. "
              f"Have {T}, need {need - T} more (~{(need - T) / 96:.1f} days at 96/day).")
        print("    No p-value is printed by design: an unstable SE errs in EITHER direction.")
        return

    mb = sum(betas) / T
    se = newey_west_se(betas, lag)
    lo, hi = block_bootstrap(betas, stamps)
    alpha = ALPHA_PRIMARY if is_primary else ALPHA_SECONDARY

    # Both estimators, always, side by side.
    if se != se or se <= 0:
        print(f"    Fama-MacBeth : mean beta={mb:+.6g}  SE=unstable (NW returned non-positive)")
        verdict_fm = "UNUSABLE"
    else:
        z = mb / se
        p = two_sided_p(z)
        print(f"    Fama-MacBeth : mean beta={mb:+.6g}  NW SE={se:.6g}  z={z:+.2f}  p={p:.4f}"
              f"  (alpha={alpha:.5f})")
        verdict_fm = "SIGNIFICANT" if p < alpha else "null"
    print(f"    Block bootstrap: 95% CI [{lo:+.6g}, {hi:+.6g}]"
          f"  -> {'excludes 0' if (lo > 0 or hi < 0) else 'includes 0'}")
    boot_sig = (lo > 0 or hi < 0)
    print(f"    VERDICT: FM={verdict_fm} | bootstrap={'excludes 0' if boot_sig else 'null'}"
          + ("   *** THEY DISAGREE — this is itself a finding (prereg s5.4) ***"
             if (verdict_fm == "SIGNIFICANT") != boot_sig else ""))


def main():
    rows = load()
    if not rows:
        print("no archived records found — run scripts/backfill_outcomes.ts first")
        sys.exit(1)
    ts_all = {r["ts"] for r in rows}
    print("=" * 78)
    print("HARNESS ANALYSIS — per HARNESS-PREREG.md (frozen 2026-08-02, sha c82246c9)")
    print(f"joined records: {len(rows)} | distinct timestamps with outcomes: {len(ts_all)}")
    print("NOTE: only rows whose outcomes have been backfilled count. Collection runs")
    print("      ~2 days ahead of this because a row matures 48h before it is archived.")
    print("=" * 78)

    report(rows, PRIMARY[0], PRIMARY[1], True)
    print("\n" + "=" * 78)
    print(f"SECONDARY (Bonferroni alpha={ALPHA_SECONDARY:.5f} for {N_TESTS} tests)")
    print("=" * 78)
    for p in PREDICTORS:
        for h in HORIZONS:
            if (p, h) == PRIMARY:
                continue
            report(rows, p, h, False)


if __name__ == "__main__":
    main()
