"""
MarketMind real-data providers (no simulator, no invented prices).

  NseProvider    nseindia.com public JSON (NIFTY 500 constituents + all indices) - 2 requests per cycle,
                 near real time, free, no account. Works best from a home / office connection; NSE blocks
                 many cloud IP ranges.
  YahooProvider  Yahoo Finance batched quote endpoint (<=100 symbols per request, one request per chunk,
                 NOT one request per stock). Delayed, unofficial, may be rate limited. Last-resort fallback.

Fyers (true tick-by-tick WebSocket) lives in main.py because it needs your broker credentials.

Everything that parses data is a pure function so it can be unit-tested without a network.
Only the stdlib is imported at module level; httpx is imported lazily by the provider classes.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set

log = logging.getLogger("marketmind.providers")

IST = timezone(timedelta(hours=5, minutes=30))

NSE_INDEX_NAMES: Dict[str, str] = {
    "NIFTY 50": "NIFTY50",
    "NIFTY BANK": "BANKNIFTY",
    "NIFTY FINANCIAL SERVICES": "FINNIFTY",
    "NIFTY MIDCAP SELECT": "MIDCPNIFTY",
    "NIFTY IT": "NIFTYIT",
    "INDIA VIX": "INDIAVIX",
}

YAHOO_INDEX_SYMBOLS: Dict[str, str] = {
    "NIFTY50": "^NSEI",
    "BANKNIFTY": "^NSEBANK",
    "SENSEX": "^BSESN",
    "FINNIFTY": "NIFTY_FIN_SERVICE.NS",
    "MIDCPNIFTY": "NIFTY_MID_SELECT.NS",
    "NIFTYIT": "^CNXIT",
    "INDIAVIX": "^INDIAVIX",
}

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


class ProviderError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def num(value: Any, default: float = 0.0) -> float:
    """Tolerant float parser: handles None, '1,234.50', '-', ''."""
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    try:
        text = str(value).replace(",", "").strip()
        if text in ("", "-", "--"):
            return default
        return float(text)
    except ValueError:
        return default


def is_market_open(now: Optional[datetime] = None) -> bool:
    """NSE cash session: Mon-Fri 09:15-15:30 IST (exchange holidays are not modelled)."""
    now = (now or datetime.now(IST)).astimezone(IST)
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return 9 * 60 + 15 <= minutes <= 15 * 60 + 30


def parse_nse_time(text: Any) -> float:
    """'31-Oct-2026 15:30:00' (IST) -> epoch seconds; falls back to now."""
    try:
        return datetime.strptime(str(text), "%d-%b-%Y %H:%M:%S").replace(tzinfo=IST).timestamp()
    except (ValueError, TypeError):
        return time.time()


def make_tick(
    key: str, ltp: float, prev: float, change: Optional[float], chp: Optional[float],
    o: float, h: float, l: float, v: float, ts: float,
) -> Optional[Dict[str, Any]]:
    if ltp <= 0:
        return None
    if prev <= 0:
        prev = ltp
    if change is None:
        change = ltp - prev
    if chp is None:
        chp = (change / prev * 100.0) if prev else 0.0
    if ts <= 0 or ts > time.time() + 300:
        ts = time.time()
    return {
        "s": key, "ltp": ltp, "pc": prev, "ch": round(change, 4), "chp": round(chp, 4),
        "o": o or ltp, "h": h or ltp, "l": l or ltp, "v": v, "t": ts,
    }


# --------------------------------------------------------------------------- #
# Pure parsers (unit-testable)
# --------------------------------------------------------------------------- #

def parse_nse_stocks(payload: Dict[str, Any], wanted: Set[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for row in payload.get("data", []) or []:
        symbol = row.get("symbol")
        if not symbol:
            continue
        key = f"{symbol}.NS"
        if key not in wanted:
            continue  # skips the index summary row and stocks we do not track
        tick = make_tick(
            key,
            num(row.get("lastPrice")),
            num(row.get("previousClose")),
            num(row.get("change"), default=float("nan")),
            num(row.get("pChange"), default=float("nan")),
            num(row.get("open")),
            num(row.get("dayHigh")),
            num(row.get("dayLow")),
            num(row.get("totalTradedVolume")),
            parse_nse_time(row.get("lastUpdateTime")),
        )
        if tick is not None:
            if tick["ch"] != tick["ch"]:  # NaN guard
                tick["ch"] = round(tick["ltp"] - tick["pc"], 4)
            if tick["chp"] != tick["chp"]:
                tick["chp"] = round((tick["ltp"] - tick["pc"]) / tick["pc"] * 100.0, 4)
            y_hi, y_lo = num(row.get("yearHigh")), num(row.get("yearLow"))
            if y_hi > 0 and y_lo > 0:
                tick["y52h"], tick["y52l"] = y_hi, y_lo
            if row.get("perChange30d") not in (None, "", "-"):
                tick["c30"] = num(row.get("perChange30d"))
            out[key] = tick
    return out


def parse_nse_quote_equity(payload: Dict[str, Any], key: str) -> Optional[Dict[str, Any]]:
    """NSE /api/quote-equity (single stock) -> (tick + 'name')."""
    pi = payload.get("priceInfo") or {}
    hl = pi.get("intraDayHighLow") or {}
    wk = pi.get("weekHighLow") or {}
    volume = num((payload.get("securityWiseDP") or {}).get("quantityTraded"))
    if volume <= 0:
        volume = num(((payload.get("marketDeptOrderBook") or {}).get("tradeInfo") or {}).get("totalTradedVolume"))
    tick = make_tick(
        key,
        num(pi.get("lastPrice")),
        num(pi.get("previousClose")),
        None if pi.get("change") is None else num(pi.get("change")),
        None if pi.get("pChange") is None else num(pi.get("pChange")),
        num(pi.get("open")),
        num(hl.get("max")),
        num(hl.get("min")),
        volume,
        parse_nse_time((payload.get("metadata") or {}).get("lastUpdateTime")),
    )
    if tick is None:
        return None
    if num(wk.get("max")) > 0 and num(wk.get("min")) > 0:
        tick["y52h"], tick["y52l"] = num(wk.get("max")), num(wk.get("min"))
    tick["name"] = str((payload.get("info") or {}).get("companyName") or key.replace(".NS", ""))
    return tick


def parse_nse_indices(payload: Dict[str, Any], wanted: Set[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    ts = parse_nse_time(payload.get("timestamp"))
    for row in payload.get("data", []) or []:
        key = NSE_INDEX_NAMES.get(str(row.get("index") or row.get("indexSymbol") or "").upper())
        if key is None or key not in wanted:
            continue
        tick = make_tick(
            key,
            num(row.get("last")),
            num(row.get("previousClose")),
            None,
            None,
            num(row.get("open")),
            num(row.get("high")),
            num(row.get("low")),
            0.0,
            ts,
        )
        if tick is not None:
            out[key] = tick
    return out


def parse_yahoo_quotes(payload: Dict[str, Any], symbol_to_key: Dict[str, str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    results = ((payload.get("quoteResponse") or {}).get("result")) or []
    for row in results:
        key = symbol_to_key.get(str(row.get("symbol")))
        if key is None:
            continue
        tick = make_tick(
            key,
            num(row.get("regularMarketPrice")),
            num(row.get("regularMarketPreviousClose")),
            num(row.get("regularMarketChange"), default=float("nan")),
            num(row.get("regularMarketChangePercent"), default=float("nan")),
            num(row.get("regularMarketOpen")),
            num(row.get("regularMarketDayHigh")),
            num(row.get("regularMarketDayLow")),
            num(row.get("regularMarketVolume")),
            num(row.get("regularMarketTime")),
        )
        if tick is not None:
            if tick["ch"] != tick["ch"]:
                tick["ch"] = round(tick["ltp"] - tick["pc"], 4)
            if tick["chp"] != tick["chp"]:
                tick["chp"] = round((tick["ltp"] - tick["pc"]) / tick["pc"] * 100.0, 4)
            name = row.get("longName") or row.get("shortName")
            if name:
                tick["name"] = str(name)
            out[key] = tick
    return out


# --------------------------------------------------------------------------- #
# Network providers
# --------------------------------------------------------------------------- #

class NseProvider:
    name = "nse"
    BASE = "https://www.nseindia.com"

    def __init__(self) -> None:
        self._client: Any = None
        self._warmed_at = 0.0

    def _headers(self) -> Dict[str, str]:
        return {
            "User-Agent": BROWSER_UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
            "Referer": f"{self.BASE}/market-data/live-equity-market",
        }

    async def _ensure_client(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(timeout=12.0, follow_redirects=True)
        if time.time() - self._warmed_at > 240:  # NSE requires cookies from a normal page visit
            await self._client.get(self.BASE + "/", headers={**self._headers(), "Accept": "text/html,*/*"})
            self._warmed_at = time.time()
        return self._client

    async def _get_json(self, path: str, params: Dict[str, str]) -> Dict[str, Any]:
        client = await self._ensure_client()
        resp = await client.get(self.BASE + path, params=params, headers=self._headers())
        if resp.status_code in (401, 403):
            self._warmed_at = 0.0
            raise ProviderError(f"NSE blocked the request (HTTP {resp.status_code})")
        if resp.status_code != 200:
            raise ProviderError(f"NSE HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError as exc:
            self._warmed_at = 0.0
            raise ProviderError("NSE returned non-JSON (cookie/anti-bot page)") from exc

    async def fetch(self, wanted: Set[str]) -> Dict[str, Dict[str, Any]]:
        stocks = await self._get_json("/api/equity-stockIndices", {"index": "NIFTY 500"})
        out = parse_nse_stocks(stocks, wanted)
        try:
            indices = await self._get_json("/api/allIndices", {})
            out.update(parse_nse_indices(indices, wanted))
        except ProviderError as exc:
            log.warning("NSE indices unavailable: %s", exc)
        if not out:
            raise ProviderError("NSE responded but contained none of the tracked symbols")
        return out

    async def quote_one(self, symbol: str) -> Optional[Dict[str, Any]]:
        key = f"{symbol}.NS"
        payload = await self._get_json("/api/quote-equity", {"symbol": symbol})
        return parse_nse_quote_equity(payload, key)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()


class YahooProvider:
    name = "yahoo"

    def __init__(self, key_to_yahoo: Dict[str, str]) -> None:
        self._key_to_yahoo = key_to_yahoo
        self._client: Any = None
        self._crumb = ""

    async def _ensure_client(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(timeout=12.0, follow_redirects=True, headers={"User-Agent": BROWSER_UA})
        if not self._crumb:
            await self._client.get("https://fc.yahoo.com")  # sets the consent cookie (404 body is expected)
            resp = await self._client.get("https://query1.finance.yahoo.com/v1/test/getcrumb")
            if resp.status_code != 200 or not resp.text.strip():
                raise ProviderError(f"Yahoo crumb request failed (HTTP {resp.status_code})")
            self._crumb = resp.text.strip()
        return self._client

    async def fetch(self, wanted: Set[str]) -> Dict[str, Dict[str, Any]]:
        symbol_to_key = {self._key_to_yahoo[k]: k for k in wanted if k in self._key_to_yahoo}
        symbols: List[str] = list(symbol_to_key)
        out: Dict[str, Dict[str, Any]] = {}
        client = await self._ensure_client()
        for i in range(0, len(symbols), 100):
            chunk = symbols[i : i + 100]
            for attempt in (1, 2):
                resp = await client.get(
                    "https://query1.finance.yahoo.com/v7/finance/quote",
                    params={"symbols": ",".join(chunk), "crumb": self._crumb},
                )
                if resp.status_code == 401 and attempt == 1:
                    self._crumb = ""
                    client = await self._ensure_client()
                    continue
                break
            if resp.status_code == 429:
                raise ProviderError("Yahoo rate limit (HTTP 429)")
            if resp.status_code != 200:
                raise ProviderError(f"Yahoo HTTP {resp.status_code}")
            out.update(parse_yahoo_quotes(resp.json(), symbol_to_key))
        if not out:
            raise ProviderError("Yahoo responded but contained none of the tracked symbols")
        return out

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()