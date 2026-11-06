"""
MarketMind backtest: does the rule-based signal actually carry information?

It replays the SAME scoring rules the website uses (trend vs 20/50-day averages, RSI, 30-day momentum,
day move, 52-week position) on every past trading day of every stock, using only data available on that
day, then looks at what the stock did afterwards.

What it reports, honestly
  * raw average forward return and hit rate per verdict
  * excess return versus the average stock on the same day (strips out market-wide moves)
  * a standard error that clusters by date, because stocks move together; "significant" means the
    excess return is more than 2 standard errors from zero
  * a simulated trade for buy signals: 5% stop, 8% target, 20-day time exit, round-trip costs deducted

Limits you should keep in mind: about one year of data, only stocks that still exist (survivorship bias),
no slippage model beyond a flat cost, and a past result is not a promise.

Pure functions, no network. Candle = (epoch_seconds, close, high, low).
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    from .analytics import Candle, _ist_day, rsi_wilder, sma
except ImportError:  # pragma: no cover
    from analytics import Candle, _ist_day, rsi_wilder, sma  # type: ignore

HORIZONS = (5, 10, 20)
MIN_BARS = 51  # the 50-day average needs 50 closes
TARGET_PCT = 0.08
STOP_PCT = 0.05
TRADE_DAYS = 20
DEFAULT_COST_PCT = 0.25  # round-trip brokerage, taxes and slippage, in percent

BUY = ("STRONG BUY", "ACCUMULATE")
VERDICTS = ("STRONG BUY", "ACCUMULATE", "HOLD", "SELL / BOOK PROFIT")


def _clamp(x: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, x))


def score_at(closes: Sequence[float], i: int) -> Optional[Tuple[int, str]]:
    """Score and verdict using only closes[0..i]. Mirrors computeSignal() in the website."""
    if i < MIN_BARS - 1 or i >= len(closes):
        return None
    window = closes[: i + 1]
    price = window[-1]
    prev = window[-2]
    if price <= 0 or prev <= 0:
        return None
    sma20 = sma(window, 20)
    sma50 = sma(window, 50)
    rsi = rsi_wilder(window)
    ret30 = (price / window[-22] - 1.0) * 100.0 if len(window) > 21 and window[-22] > 0 else None
    chg = (price / prev - 1.0) * 100.0
    last252 = window[-252:]
    hi, lo = max(last252), min(last252)
    pos52 = (price - lo) / (hi - lo) if hi > lo else None

    s = 50.0
    if sma50 is not None:
        s += 12 if price > sma50 else -12
    if sma20 is not None:
        s += 6 if price > sma20 else -6
    if rsi is not None:
        if rsi >= 75:
            s -= 8
        elif rsi >= 60:
            s += 8
        elif rsi >= 45:
            s += 4
        elif rsi >= 30:
            s -= 4
        else:
            s -= 6
    if ret30 is not None:
        s += _clamp(ret30, -20, 20) * 0.7
    s += _clamp(chg, -4, 4) * 1.5
    if pos52 is not None:
        if pos52 >= 0.85:
            s += 5
        elif pos52 <= 0.15:
            s -= 6
    score = int(round(_clamp(s, 1, 99)))

    book_profit = rsi is not None and rsi >= 75 and (ret30 or 0) >= 8
    if book_profit:
        verdict = "SELL / BOOK PROFIT"
    elif score >= 72:
        verdict = "STRONG BUY"
    elif score >= 58:
        verdict = "ACCUMULATE"
    elif score >= 42:
        verdict = "HOLD"
    else:
        verdict = "SELL / BOOK PROFIT"
    return score, verdict


def simulate_trade(
    candles: Sequence[Candle], i: int, cost_pct: float = DEFAULT_COST_PCT
) -> Optional[Tuple[float, str]]:
    """Enter at close[i]; 5% stop, 8% target, exit at close after 20 days. Stop wins if both hit the same day."""
    if i + 1 >= len(candles):
        return None
    entry = candles[i][1]
    stop = entry * (1 - STOP_PCT)
    target = entry * (1 + TARGET_PCT)
    last = min(len(candles) - 1, i + TRADE_DAYS)
    if last <= i:
        return None
    for j in range(i + 1, last + 1):
        _, close, high, low = candles[j]
        if low <= stop:
            return (-STOP_PCT * 100 - cost_pct, "stop")
        if high >= target:
            return (TARGET_PCT * 100 - cost_pct, "target")
    if last - i < TRADE_DAYS:
        return None  # not enough future to judge a full trade
    return ((candles[last][1] / entry - 1) * 100 - cost_pct, "time")


def _stats(values: List[float]) -> Dict[str, Any]:
    if not values:
        return {"n": 0, "mean": None, "median": None, "hit": None}
    return {
        "n": len(values),
        "mean": round(statistics.fmean(values), 3),
        "median": round(statistics.median(values), 3),
        "hit": round(100.0 * sum(1 for v in values if v > 0) / len(values), 1),
    }


def run_backtest(
    candle_sets: Dict[str, Sequence[Candle]],
    horizons: Sequence[int] = HORIZONS,
    cost_pct: float = DEFAULT_COST_PCT,
) -> Dict[str, Any]:
    # observations[(h)] -> list of (day, verdict, raw_return)
    obs: Dict[int, List[Tuple[str, str, float]]] = {h: [] for h in horizons}
    trades: List[Tuple[float, str]] = []
    stocks_used = 0

    for _, candles in candle_sets.items():
        if len(candles) < MIN_BARS + min(horizons):
            continue
        closes = [c[1] for c in candles]
        days = [_ist_day(c[0]) for c in candles]
        stocks_used += 1
        for i in range(MIN_BARS - 1, len(candles) - 1):
            res = score_at(closes, i)
            if res is None:
                continue
            _, verdict = res
            for h in horizons:
                if i + h < len(candles) and closes[i] > 0:
                    obs[h].append((days[i], verdict, (closes[i + h] / closes[i] - 1.0) * 100.0))
            if verdict in BUY:
                t = simulate_trade(candles, i, cost_pct)
                if t is not None:
                    trades.append(t)

    buckets: Dict[str, Dict[str, Any]] = {v: {} for v in VERDICTS}
    buckets["ALL BUY"] = {}
    baseline: Dict[str, Any] = {}

    for h in horizons:
        rows = obs[h]
        baseline[str(h)] = _stats([r for _, _, r in rows])
        by_day: Dict[str, List[float]] = defaultdict(list)
        for d, _, r in rows:
            by_day[d].append(r)
        day_mean = {d: statistics.fmean(v) for d, v in by_day.items()}

        def bucket_stats(selected: List[Tuple[str, str, float]]) -> Dict[str, Any]:
            base = _stats([r for _, _, r in selected])
            if not selected:
                return {**base, "excess": None, "se": None, "days": 0, "significant": False}
            per_day: Dict[str, List[float]] = defaultdict(list)
            for d, _, r in selected:
                per_day[d].append(r - day_mean[d])
            means = [statistics.fmean(v) for v in per_day.values()]
            excess = statistics.fmean(means)
            n_days = len(means)
            if n_days >= 2:
                eff = max(1.0, n_days / h)  # overlapping windows: neighbouring days are not independent
                se = statistics.stdev(means) / (eff ** 0.5)
            else:
                se = None
            significant = bool(se is not None and n_days >= 30 and se > 0 and abs(excess) > 2 * se)
            return {
                **base,
                "excess": round(excess, 3),
                "se": None if se is None else round(se, 3),
                "days": n_days,
                "significant": significant,
            }

        for v in VERDICTS:
            buckets[v][str(h)] = bucket_stats([o for o in rows if o[1] == v])
        buckets["ALL BUY"][str(h)] = bucket_stats([o for o in rows if o[1] in BUY])

    trade_summary: Dict[str, Any]
    if trades:
        rets = [r for r, _ in trades]
        trade_summary = {
            "n": len(trades),
            "win_rate": round(100.0 * sum(1 for r in rets if r > 0) / len(rets), 1),
            "avg_net_return": round(statistics.fmean(rets), 3),
            "stopped_pct": round(100.0 * sum(1 for _, k in trades if k == "stop") / len(trades), 1),
            "target_pct": round(100.0 * sum(1 for _, k in trades if k == "target") / len(trades), 1),
            "timed_out_pct": round(100.0 * sum(1 for _, k in trades if k == "time") / len(trades), 1),
            "cost_pct": cost_pct,
        }
    else:
        trade_summary = {"n": 0}

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "stocks": stocks_used,
        "observations": len(obs[horizons[0]]) if horizons else 0,
        "horizons": list(horizons),
        "baseline": baseline,
        "buckets": buckets,
        "trades": trade_summary,
        "verdict_text": _verdict_text(buckets, trade_summary, stocks_used),
        "caveats": [
            "About one year of daily data, so a single market regime.",
            "Only stocks that exist today are tested (survivorship bias flatters results).",
            "Costs are a flat estimate; real slippage on illiquid stocks is higher.",
            "Past behaviour does not promise future results. This is not investment advice.",
        ],
    }


def _verdict_text(buckets: Dict[str, Dict[str, Any]], trades: Dict[str, Any], stocks: int) -> str:
    if stocks < 5:
        return "Not enough price history loaded yet to judge the signals."
    b = buckets["ALL BUY"].get("10", {})
    excess = b.get("excess")
    if excess is None:
        return "Not enough data yet to judge the signals."
    tail = ""
    if trades.get("n"):
        tail = (
            f" Simulated buy trades (5% stop, 8% target, costs deducted) averaged {trades['avg_net_return']:+.2f}% "
            f"with a {trades['win_rate']:.0f}% win rate."
        )
    if b.get("significant") and excess > 0:
        return (
            f"In this sample, buy-rated days beat the average stock by {excess:+.2f}% over 10 trading days, "
            f"which is statistically meaningful, but one year of data is a short test.{tail}"
        )
    if b.get("significant") and excess < 0:
        return (
            f"In this sample, buy-rated days did WORSE than the average stock by {excess:+.2f}% over 10 trading days. "
            f"Do not rely on the buy labels.{tail}"
        )
    return (
        f"No statistically meaningful edge found: buy-rated days differed from the average stock by {excess:+.2f}% "
        f"over 10 trading days, within the noise. Treat the labels as a description of recent price action, not a forecast.{tail}"
    )