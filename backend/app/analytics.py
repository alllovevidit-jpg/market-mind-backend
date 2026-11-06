"""
MarketMind analytics: real technical indicators from real daily candles (Yahoo Finance chart data).

Everything that computes is a pure function (unit-tested, no network).
HistoryFetcher does the network part: one request per symbol, a few at a time, then cached by the caller.

Short keys sent to the browser (per symbol):
  r    RSI(14), Wilder smoothing            s20 / s50   simple moving averages of the close
  atr  Average True Range(14)               b           beta versus NIFTY 50 (daily returns)
  h    52-week high                         l           52-week low
  r30  % change over the last ~21 sessions  hist        [[epoch_seconds, close], ...] last 90 sessions
  mh   MACD(12,26,9) histogram as % of price   pb   Bollinger %B (20,2)   v  annualised volatility % (60d)
  r6   6-month % change                          ch   Chandelier exit: 22d high - 3 x ATR
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

log = logging.getLogger("marketmind.analytics")

IST = timezone(timedelta(hours=5, minutes=30))
BENCHMARK = "^NSEI"
HIST_POINTS = 90

Candle = Tuple[float, float, float, float]  # (epoch seconds, close, high, low)


# --------------------------------------------------------------------------- #
# Pure functions
# --------------------------------------------------------------------------- #

def parse_chart(payload: Dict[str, Any]) -> List[Candle]:
    """Yahoo v8 chart payload -> ordered candles; rows with a missing close are dropped."""
    try:
        result = payload["chart"]["result"][0]
        stamps = result.get("timestamp") or []
        quote = result["indicators"]["quote"][0]
    except (KeyError, IndexError, TypeError):
        return []
    closes = quote.get("close") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    out: List[Candle] = []
    for i, ts in enumerate(stamps):
        try:
            c = closes[i]
            if c is None or c <= 0:
                continue
            h = highs[i] if highs[i] is not None else c
            lo = lows[i] if lows[i] is not None else c
            out.append((float(ts), float(c), float(h), float(lo)))
        except IndexError:
            break
    return out


def _f(value: Any) -> float:
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def parse_nse_history(payload: Any) -> List[Candle]:
    """NSE /api/historical/cm/equity rows -> ascending candles. Tolerates both date styles."""
    rows = payload.get("data") if isinstance(payload, dict) else None
    seen: Dict[str, Candle] = {}
    for r in rows or []:
        raw = str(r.get("CH_TIMESTAMP") or r.get("mTIMESTAMP") or "")
        day = None
        for fmt in ("%Y-%m-%d", "%d-%b-%Y"):
            try:
                day = datetime.strptime(raw, fmt)
                break
            except ValueError:
                continue
        close = _f(r.get("CH_CLOSING_PRICE") or r.get("CLOSE"))
        if day is None or close <= 0:
            continue
        high = _f(r.get("CH_TRADE_HIGH_PRICE") or r.get("HIGH")) or close
        low = _f(r.get("CH_TRADE_LOW_PRICE") or r.get("LOW")) or close
        ts = day.replace(hour=15, minute=30, tzinfo=IST).timestamp()
        seen[day.strftime("%Y-%m-%d")] = (ts, close, high, low)
    return [seen[k] for k in sorted(seen)]


def sma(values: Sequence[float], n: int) -> Optional[float]:
    if len(values) < n:
        return None
    return sum(values[-n:]) / n


def rsi_wilder(closes: Sequence[float], n: int = 14) -> Optional[float]:
    """RSI with Wilder's smoothing. Needs n+1 closes."""
    if len(closes) < n + 1:
        return None
    gains = 0.0
    losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gains += d
        else:
            losses -= d
    avg_gain = gains / n
    avg_loss = losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (n - 1) + max(d, 0.0)) / n
        avg_loss = (avg_loss * (n - 1) + max(-d, 0.0)) / n
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def atr_wilder(candles: Sequence[Candle], n: int = 14) -> Optional[float]:
    if len(candles) < n + 1:
        return None
    trs: List[float] = []
    for i in range(1, len(candles)):
        _, c, h, lo = candles[i]
        prev_close = candles[i - 1][1]
        trs.append(max(h - lo, abs(h - prev_close), abs(lo - prev_close)))
    atr = sum(trs[:n]) / n
    for tr in trs[n:]:
        atr = (atr * (n - 1) + tr) / n
    return atr


def ema(values: Sequence[float], n: int) -> List[float]:
    """Exponential moving average series (seeded with the first n-value SMA), same length as values from index n-1."""
    if len(values) < n or n < 1:
        return []
    k = 2.0 / (n + 1)
    out = [sum(values[:n]) / n]
    for v in values[n:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def macd_hist(closes: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9) -> Optional[float]:
    """MACD(12,26,9) histogram = MACD line - signal line, in price units. Positive = bullish momentum building."""
    if len(closes) < slow + signal:
        return None
    ef, es = ema(closes, fast), ema(closes, slow)
    ef = ef[slow - fast:]  # align both series to the same end date
    line = [a - b for a, b in zip(ef, es)]
    sig = ema(line, signal)
    return None if not sig else line[-1] - sig[-1]


def bollinger_pctb(closes: Sequence[float], n: int = 20, k: float = 2.0) -> Optional[float]:
    """%B: where price sits inside the Bollinger Bands. 0 = lower band, 1 = upper band, <0 or >1 = outside."""
    if len(closes) < n:
        return None
    w = closes[-n:]
    mid = sum(w) / n
    sd = (sum((x - mid) ** 2 for x in w) / n) ** 0.5
    if sd == 0:
        return None
    return (closes[-1] - (mid - k * sd)) / (2 * k * sd)


def annual_vol(closes: Sequence[float], window: int = 60) -> Optional[float]:
    """Annualised volatility in percent: stdev of daily log returns over the window x sqrt(252)."""
    import math

    if len(closes) < window + 1:
        return None
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(len(closes) - window, len(closes)) if closes[i - 1] > 0 and closes[i] > 0]
    if len(rets) < 10:
        return None
    m = sum(rets) / len(rets)
    var = sum((r - m) ** 2 for r in rets) / (len(rets) - 1)
    return (var ** 0.5) * (252 ** 0.5) * 100.0


def chandelier_stop(candles: Sequence[Candle], n: int = 22, mult: float = 3.0) -> Optional[float]:
    """Chandelier Exit (long): highest high of the last n sessions minus mult x ATR(14). A volatility-aware trailing stop."""
    if len(candles) < max(n, 15):
        return None
    atr = atr_wilder(candles)
    if atr is None:
        return None
    return max(h for _, _, h, _ in candles[-n:]) - mult * atr


def _ist_day(ts: float) -> str:
    return datetime.fromtimestamp(ts, IST).strftime("%Y-%m-%d")


def beta_vs(candles: Sequence[Candle], bench: Sequence[Candle], window: int = 120) -> Optional[float]:
    """Beta of daily returns versus the benchmark, aligned by IST trading day."""
    b_by_day = {_ist_day(t): c for t, c, _, _ in bench}
    pairs: List[Tuple[float, float]] = []
    for t, c, _, _ in candles:
        day = _ist_day(t)
        if day in b_by_day:
            pairs.append((c, b_by_day[day]))
    pairs = pairs[-(window + 1):]
    if len(pairs) < 21:
        return None
    rs = [pairs[i][0] / pairs[i - 1][0] - 1.0 for i in range(1, len(pairs))]
    rb = [pairs[i][1] / pairs[i - 1][1] - 1.0 for i in range(1, len(pairs))]
    mean_s = sum(rs) / len(rs)
    mean_b = sum(rb) / len(rb)
    var_b = sum((x - mean_b) ** 2 for x in rb)
    if var_b == 0:
        return None
    cov = sum((x - mean_s) * (y - mean_b) for x, y in zip(rs, rb))
    return cov / var_b


def build_analytics(candles: Sequence[Candle], bench: Sequence[Candle]) -> Optional[Dict[str, Any]]:
    if len(candles) < 20:
        return None
    closes = [c for _, c, _, _ in candles]
    last = closes[-1]
    window = closes[-252:]
    r30 = None
    if len(closes) > 21 and closes[-22] > 0:
        r30 = (last / closes[-22] - 1.0) * 100.0

    def rnd(x: Optional[float], d: int = 2) -> Optional[float]:
        return None if x is None else round(x, d)

    return {
        "r": rnd(rsi_wilder(closes)),
        "s20": rnd(sma(closes, 20)),
        "s50": rnd(sma(closes, 50)),
        "atr": rnd(atr_wilder(candles)),
        "b": rnd(beta_vs(candles, bench), 3),
        "h": rnd(max(window)),
        "l": rnd(min(window)),
        "r30": rnd(r30),
        "mh": rnd(None if (m := macd_hist(closes)) is None else m / last * 100.0, 3),
        "pb": rnd(bollinger_pctb(closes), 3),
        "v": rnd(annual_vol(closes), 1),
        "r6": rnd((last / closes[-127] - 1.0) * 100.0 if len(closes) > 126 and closes[-127] > 0 else None),
        "ch": rnd(chandelier_stop(candles)),
        "hist": [[int(t), round(c, 2)] for t, c, _, _ in candles[-HIST_POINTS:]],
    }


# --------------------------------------------------------------------------- #
# Network
# --------------------------------------------------------------------------- #

class HistoryFetcher:
    CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

    def __init__(self, user_agent: str, nse_get: Any = None) -> None:
        self._ua = user_agent
        self._nse_get = nse_get  # async (path, params) -> dict, supplied by NseProvider
        self._client: Any = None
        self._bench: List[Candle] = []
        self._bench_at = 0.0
        self._yahoo_fail_streak = 0
        self._yahoo_blocked_until = 0.0
        self.last_error = ""
        self.candle_cache: Dict[str, List[Candle]] = {}  # kept for the backtest

    async def _ensure(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(timeout=15.0, follow_redirects=True, headers={"User-Agent": self._ua})
        return self._client

    async def _yahoo_candles(self, yahoo_symbol: str) -> List[Candle]:
        client = await self._ensure()
        resp = await client.get(self.CHART_URL.format(symbol=yahoo_symbol), params={"range": "1y", "interval": "1d"})
        if resp.status_code != 200:
            raise RuntimeError(f"Yahoo history HTTP {resp.status_code}")
        return parse_chart(resp.json())

    async def _nse_candles(self, symbol: str) -> List[Candle]:
        if self._nse_get is None:
            raise RuntimeError("no NSE history source configured")
        today = datetime.now(IST).date()
        payload = await self._nse_get(
            "/api/historical/cm/equity",
            {
                "symbol": symbol,
                "series": '["EQ"]',
                "from": (today - timedelta(days=365)).strftime("%d-%m-%Y"),
                "to": today.strftime("%d-%m-%Y"),
            },
        )
        return parse_nse_history(payload)

    async def candles(self, yahoo_symbol: str, nse_symbol: Optional[str] = None) -> List[Candle]:
        """Yahoo first; if it fails (or has been failing), NSE's own historical endpoint."""
        if time.time() >= self._yahoo_blocked_until:
            try:
                out = await self._yahoo_candles(yahoo_symbol)
                self._yahoo_fail_streak = 0
                if out:
                    return out
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)[:120]
                self._yahoo_fail_streak += 1
                if self._yahoo_fail_streak >= 5:  # stop hammering a source that is refusing us
                    self._yahoo_blocked_until = time.time() + 600
                    self._yahoo_fail_streak = 0
        if nse_symbol and self._nse_get is not None:
            try:
                out = await self._nse_candles(nse_symbol)
                if out:
                    return out
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"{self.last_error}; NSE history: {str(exc)[:80]}".strip("; ")
        return []

    async def benchmark(self) -> List[Candle]:
        """NIFTY 50 candles for beta. Optional: if unavailable, beta is simply missing."""
        if not self._bench or time.time() - self._bench_at > 6 * 3600:
            try:
                self._bench = await self._yahoo_candles(BENCHMARK)
                self._bench_at = time.time()
            except Exception as exc:  # noqa: BLE001
                log.info("benchmark unavailable, beta will be blank: %s", str(exc)[:80])
                self._bench = []
        return self._bench

    async def analytics_for(self, yahoo_symbol: str, nse_symbol: Optional[str] = None) -> Optional[Dict[str, Any]]:
        bench = await self.benchmark()
        candles = await self.candles(yahoo_symbol, nse_symbol)
        if candles:
            self.candle_cache[yahoo_symbol] = candles
        return build_analytics(candles, bench)

    async def fetch_many(
        self, key_to_yahoo: Dict[str, str], concurrency: int = 4, gap: float = 0.25
    ) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        sem = asyncio.Semaphore(concurrency)

        async def one(key: str, ysym: str) -> None:
            async with sem:
                try:
                    nse_sym = key[:-3] if key.endswith(".NS") else None
                    result = await self.analytics_for(ysym, nse_sym)
                    if result is not None:
                        out[key] = result
                except Exception as exc:  # noqa: BLE001
                    self.last_error = str(exc)[:120]
                await asyncio.sleep(gap)

        await asyncio.gather(*(one(k, y) for k, y in key_to_yahoo.items()))
        log.info("history: %d/%d symbols analysed%s", len(out), len(key_to_yahoo),
                 f" (last error: {self.last_error})" if self.last_error and len(out) < len(key_to_yahoo) else "")
        return out

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()