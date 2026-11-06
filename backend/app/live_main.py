"""
MarketMind backend: FastAPI + a chain of REAL Indian market-data sources (no simulator).

Prices, best source first
  1. Fyers API v3 WebSocket   true tick-by-tick, needs FYERS_APP_ID + FYERS_ACCESS_TOKEN
  2. NSE website JSON         near real time, no account, 2 requests per cycle
  3. Yahoo Finance batch      delayed, unofficial, batched
Analytics (RSI, moving averages, ATR, beta, 52-week range, 90-day history)
  Real daily candles from Yahoo's chart endpoint, refreshed every 3 hours.

Browser socket  ws://<host>:8000/ws/market  sends:
  {"type": "hello"|"status", ...feed status...}
  {"type": "snapshot", "data": {<key>: <tick>}}           once on connect
  {"type": "analytics", "data": {<key>: <analytics>}}      once on connect, again after each refresh
  {"type": "ticks", "data": [<tick>, ...]}                 coalesced every ~100 ms
and accepts   {"action": "track", "symbols": ["ZENSARTECH.NS", ...]}   to stream extra NSE symbols.

REST
  GET /health
  GET /api/v1/market/lookup/{symbol}     live quote + analytics for any NSE symbol
  GET /api/v1/market/news/{symbol}       real headlines (Google News RSS), shown as published
  GET /api/v1/backtest                   how the buy/sell signals performed on past data (refreshed every 6 h)

Optional protection: set MARKETMIND_API_KEY and every REST call must send header X-API-Key (the WebSocket takes ?key=).

Run (from the backend folder):
    pip install fastapi "uvicorn[standard]" httpx fyers-apiv3
    uvicorn app.live_main:app --port 8000
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Set

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

try:  # works as a package (uvicorn app.live_main:app) and as a plain script folder
    from .analytics import HistoryFetcher
    from .backtest import run_backtest
    from .news import NewsFetcher
    from .providers import (
        BROWSER_UA,
        YAHOO_INDEX_SYMBOLS,
        NseProvider,
        YahooProvider,
        is_market_open,
        make_tick,
        num,
    )
except ImportError:  # pragma: no cover
    from analytics import HistoryFetcher  # type: ignore
    from backtest import run_backtest  # type: ignore
    from news import NewsFetcher  # type: ignore
    from providers import (  # type: ignore
        BROWSER_UA,
        YAHOO_INDEX_SYMBOLS,
        NseProvider,
        YahooProvider,
        is_market_open,
        make_tick,
        num,
    )

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("marketmind")

# --------------------------------------------------------------------------- #
# Instrument universe (172 equities + 7 indices = 179 subscriptions, Fyers limit 200)
# --------------------------------------------------------------------------- #

NSE_EQUITIES: List[str] = """
HDFCBANK ICICIBANK SBIN KOTAKBANK AXISBANK INDUSINDBK BANKBARODA PNB CANBK UNIONBANK IDFCFIRSTB FEDERALBNK AUBANK BANDHANBNK YESBANK INDIANB
BAJFINANCE BAJAJFINSV HDFCLIFE SBILIFE ICICIPRULI ICICIGI CHOLAFIN SHRIRAMFIN MUTHOOTFIN LICHSGFIN PFC RECLTD JIOFIN SBICARD HDFCAMC
TCS INFY WIPRO HCLTECH TECHM LTM PERSISTENT COFORGE MPHASIS OFSS KPITTECH
MARUTI M&M BAJAJ-AUTO EICHERMOT HEROMOTOCO TVSMOTOR ASHOKLEY BOSCHLTD MOTHERSON BHARATFORG BALKRISIND APOLLOTYRE MRF SONACOMS
RELIANCE ONGC IOC BPCL GAIL COALINDIA NTPC POWERGRID TATAPOWER ADANIGREEN ADANIPOWER NHPC PETRONET OIL JSWENERGY HINDPETRO
TATASTEEL JSWSTEEL HINDALCO VEDL SAIL NMDC JINDALSTEL APLAPOLLO HINDZINC NATIONALUM
HINDUNILVR ITC NESTLEIND BRITANNIA TATACONSUM DABUR GODREJCP MARICO COLPAL VBL UNITDSPR
SUNPHARMA DRREDDY CIPLA DIVISLAB LUPIN AUROPHARMA TORNTPHARM ZYDUSLIFE ALKEM MANKIND APOLLOHOSP MAXHEALTH FORTIS BIOCON
LT ADANIENT ADANIPORTS ULTRACEMCO GRASIM AMBUJACEM SHREECEM ACC SIEMENS ABB HAL BEL BHEL CUMMINSIND POLYCAB HAVELLS
DLF GODREJPROP OBEROIRLTY LODHA PRESTIGE
TITAN ASIANPAINT ETERNAL TRENT DMART NYKAA PAYTM POLICYBZR IRCTC INDIGO PIDILITIND BERGEPAINT PAGEIND
DIXON VOLTAS BLUESTARCO
BHARTIARTL IDEA INDUSTOWER TATACOMM
SRF UPL PIIND DEEPAKNTR TATACHEM NAVINFLUOR
IRFC RVNL MAZDOCK COCHINSHIP BDL
LICI SWIGGY HYUNDAI NAUKRI MCX BSE CDSL ANGELONE IEX TATAELXSI
DELHIVERY JUBLFOOD KALYANKJIL
""".split()

KEY_TO_FYERS: Dict[str, str] = {f"{t}.NS": f"NSE:{t}-EQ" for t in NSE_EQUITIES}
INDEX_KEY_TO_FYERS: Dict[str, str] = {
    "NIFTY50": "NSE:NIFTY50-INDEX",
    "BANKNIFTY": "NSE:NIFTYBANK-INDEX",
    "SENSEX": "BSE:SENSEX-INDEX",
    "FINNIFTY": "NSE:FINNIFTY-INDEX",
    "MIDCPNIFTY": "NSE:MIDCPNIFTY-INDEX",
    "NIFTYIT": "NSE:NIFTYIT-INDEX",
    "INDIAVIX": "NSE:INDIAVIX-INDEX",
}
KEY_TO_FYERS.update(INDEX_KEY_TO_FYERS)
FYERS_TO_KEY: Dict[str, str] = {v: k for k, v in KEY_TO_FYERS.items()}
ALL_KEYS: Set[str] = set(KEY_TO_FYERS)
ALL_FYERS_SYMBOLS: List[str] = list(KEY_TO_FYERS.values())

# Yahoo uses "<TICKER>.NS" for stocks, which is exactly our key; indices need their own symbols.
KEY_TO_YAHOO: Dict[str, str] = {k: k for k in KEY_TO_FYERS if k.endswith(".NS")}
KEY_TO_YAHOO.update(YAHOO_INDEX_SYMBOLS)
STOCK_KEYS_FOR_HISTORY: Dict[str, str] = {k: v for k, v in KEY_TO_YAHOO.items() if k.endswith(".NS")}

SYMBOL_RE = re.compile(r"^[A-Z0-9&\-]{1,20}$")
MAX_EXTRA = 30

FYERS_APP_ID = os.getenv("FYERS_APP_ID", "").strip()
FYERS_ACCESS_TOKEN = os.getenv("FYERS_ACCESS_TOKEN", "").strip()
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
]
API_KEY = os.getenv("MARKETMIND_API_KEY", "").strip()
MAX_CLIENTS = int(os.getenv("MAX_CLIENTS", "100"))
BACKTEST_REFRESH_SECONDS = float(os.getenv("BACKTEST_REFRESH_SECONDS", str(6 * 3600)))
FLUSH_INTERVAL = 0.10
POLL_OPEN_SECONDS = float(os.getenv("POLL_OPEN_SECONDS", "6"))
POLL_CLOSED_SECONDS = float(os.getenv("POLL_CLOSED_SECONDS", "120"))
ANALYTICS_REFRESH_SECONDS = float(os.getenv("ANALYTICS_REFRESH_SECONDS", str(3 * 3600)))

SOURCE_LABELS = {
    "fyers": "Fyers, live ticks",
    "nse": "NSE, near real-time",
    "yahoo": "Yahoo, delayed",
    "none": "No data source",
}


# --------------------------------------------------------------------------- #
# Hub
# --------------------------------------------------------------------------- #

class MarketHub:
    def __init__(self) -> None:
        self.latest: Dict[str, Dict[str, Any]] = {}
        self.pending: Dict[str, Dict[str, Any]] = {}
        self.analytics: Dict[str, Dict[str, Any]] = {}
        self.extra: Set[str] = set()
        self.clients: Set[WebSocket] = set()
        self.last_tick_at = 0.0
        self.fyers_configured = False
        self.fyers_ok = False
        self.fyers_last_tick = 0.0
        self.fyers_started_at = time.time()
        self.poll_source: Optional[str] = None
        self.poll_detail = ""
        self.note = ""
        self.analytics_note = ""
        self.updated_at = 0.0
        self.backtest: Optional[Dict[str, Any]] = None
        self.started_at = time.time()

    def ingest(self, tick: Dict[str, Any]) -> None:
        """Runs on the asyncio loop thread."""
        old = self.latest.get(tick["s"])
        if old is not None:
            if tick["t"] < old["t"]:
                return  # never let older data overwrite newer data
            if tick["ltp"] == old["ltp"] and tick["v"] == old["v"] and tick["pc"] == old["pc"]:
                self.updated_at = time.time()
                return
        self.latest[tick["s"]] = tick
        self.pending[tick["s"]] = tick
        self.last_tick_at = time.time()
        self.updated_at = self.last_tick_at

    def fyers_healthy(self) -> bool:
        if not (self.fyers_configured and self.fyers_ok):
            return False
        if not is_market_open():
            return True
        return time.time() - max(self.fyers_last_tick, self.fyers_started_at) < 60

    def source(self) -> str:
        if self.fyers_healthy():
            return "fyers"
        return self.poll_source or "none"

    def missing_symbols(self) -> List[str]:
        """Universe stocks that no source has priced. Only meaningful once the feed is clearly working."""
        if len(self.latest) < 20 or time.time() - self.started_at < 45:
            return []
        return sorted(k for k in STOCK_KEYS_FOR_HISTORY if k not in self.latest)

    def is_stale(self) -> bool:
        """Market open but nothing (not even an unchanged poll) has arrived for too long."""
        if not is_market_open() or self.updated_at == 0:
            return False
        return time.time() - self.updated_at > max(45.0, POLL_OPEN_SECONDS * 6)

    def status(self) -> Dict[str, Any]:
        src = self.source()
        detail = ""
        if src == "fyers":
            detail = "Tick-by-tick via Fyers WebSocket."
        elif src in ("nse", "yahoo"):
            detail = self.poll_detail
            if not self.fyers_configured:
                detail += " Add FYERS_APP_ID / FYERS_ACCESS_TOKEN for true tick-by-tick data."
        return {
            "source": src,
            "label": SOURCE_LABELS[src],
            "detail": detail.strip(),
            "note": " ".join(x for x in (self.note, self.analytics_note) if x),
            "delayed": src == "yahoo",
            "updatedAt": self.updated_at,
            "marketOpen": is_market_open(),
            "stale": self.is_stale(),
            "missing": self.missing_symbols(),
        }

    async def _send(self, ws: WebSocket, payload: str) -> bool:
        try:
            await asyncio.wait_for(ws.send_text(payload), timeout=2.0)
            return True
        except Exception:
            return False

    async def broadcast(self, message: Dict[str, Any]) -> None:
        if not self.clients:
            return
        payload = json.dumps(message, separators=(",", ":"))
        clients = list(self.clients)
        results = await asyncio.gather(*(self._send(ws, payload) for ws in clients))
        for ws, ok in zip(clients, results):
            if not ok:
                self.clients.discard(ws)

    async def flush_loop(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_INTERVAL)
            if not self.pending:
                continue
            batch = list(self.pending.values())
            self.pending.clear()
            await self.broadcast({"type": "ticks", "data": batch})

    async def status_loop(self) -> None:
        while True:
            await asyncio.sleep(3)
            await self.broadcast({"type": "status", **self.status()})


hub = MarketHub()


# --------------------------------------------------------------------------- #
# Fyers v3 (WebSocket + one-time REST snapshot)
# --------------------------------------------------------------------------- #

def fyers_tick(key: str, m: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    ltp = num(m.get("ltp"), default=num(m.get("lp")))
    prev = num(m.get("prev_close_price"))
    ts = num(m.get("last_traded_time"), default=num(m.get("exch_feed_time"), default=num(m.get("tt"))))
    chg = m.get("ch")
    chp = m.get("chp")
    return make_tick(
        key, ltp, prev,
        None if chg is None else num(chg),
        None if chp is None else num(chp),
        num(m.get("open_price")), num(m.get("high_price")), num(m.get("low_price")),
        num(m.get("vol_traded_today"), default=num(m.get("volume"))), ts,
    )


class FyersFeed:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.socket: Any = None

    def _on_connect(self) -> None:
        log.info("Fyers socket connected; subscribing to %d symbols", len(ALL_FYERS_SYMBOLS))
        self.socket.subscribe(symbols=ALL_FYERS_SYMBOLS, data_type="SymbolUpdate")
        self.socket.keep_running()

    def _on_message(self, msg: Any) -> None:
        if not isinstance(msg, dict):
            return
        key = FYERS_TO_KEY.get(str(msg.get("symbol")))
        if key is None or "ltp" not in msg:
            return
        tick = fyers_tick(key, msg)
        if tick is None:
            return
        hub.fyers_ok = True
        hub.fyers_last_tick = time.time()
        self.loop.call_soon_threadsafe(hub.ingest, tick)

    def _on_error(self, err: Any) -> None:
        log.error("Fyers socket error: %s", err)

    def _on_close(self, msg: Any) -> None:
        log.warning("Fyers socket closed: %s", msg)

    def load_snapshot_blocking(self) -> None:
        from fyers_apiv3 import fyersModel

        fy = fyersModel.FyersModel(client_id=FYERS_APP_ID, is_async=False, token=FYERS_ACCESS_TOKEN, log_path="")
        loaded = 0
        for i in range(0, len(ALL_FYERS_SYMBOLS), 50):
            chunk = ALL_FYERS_SYMBOLS[i : i + 50]
            try:
                resp = fy.quotes(data={"symbols": ",".join(chunk)})
            except Exception as exc:  # noqa: BLE001
                log.error("Fyers quotes request failed: %s", exc)
                continue
            if not isinstance(resp, dict) or resp.get("s") != "ok":
                msg = (resp or {}).get("message", "unknown error") if isinstance(resp, dict) else "bad response"
                log.error("Fyers rejected the request: %s", resp)
                hub.note = f"Fyers rejected the request ({msg}). Tokens expire daily - generate a new one. Using the fallback feed."
                return
            for item in resp.get("d", []):
                key = FYERS_TO_KEY.get(str(item.get("n")))
                values = item.get("v")
                if key is None or not isinstance(values, dict):
                    continue
                tick = fyers_tick(key, values)
                if tick is not None:
                    loaded += 1
                    self.loop.call_soon_threadsafe(hub.ingest, tick)
        if loaded:
            hub.fyers_ok = True
            hub.note = ""
        log.info("Fyers REST snapshot: %d/%d symbols", loaded, len(ALL_FYERS_SYMBOLS))

    def start(self) -> None:
        from fyers_apiv3.FyersWebsocket import data_ws

        self.socket = data_ws.FyersDataSocket(
            access_token=f"{FYERS_APP_ID}:{FYERS_ACCESS_TOKEN}",
            log_path="",
            litemode=False,
            write_to_file=False,
            reconnect=True,
            on_connect=self._on_connect,
            on_close=self._on_close,
            on_error=self._on_error,
            on_message=self._on_message,
        )
        threading.Thread(target=self.socket.connect, name="fyers-ws", daemon=True).start()

    def stop(self) -> None:
        try:
            if self.socket is not None:
                self.socket.close_connection()
        except Exception as exc:  # noqa: BLE001
            log.warning("Error closing Fyers socket: %s", exc)


# --------------------------------------------------------------------------- #
# Polling chain (NSE -> Yahoo), extra symbols, analytics
# --------------------------------------------------------------------------- #

nse = NseProvider()
yahoo = YahooProvider(KEY_TO_YAHOO)
history = HistoryFetcher(BROWSER_UA, nse_get=nse._get_json)
news = NewsFetcher(BROWSER_UA)


async def run_poll_cycle(providers: List[Any]) -> Dict[str, int]:
    missing = set(ALL_KEYS)
    counts: Dict[str, int] = {}
    errors: Dict[str, str] = {}
    for provider in providers:
        if not missing:
            break
        try:
            got = await asyncio.wait_for(provider.fetch(missing), timeout=30)
        except Exception as exc:  # noqa: BLE001
            errors[provider.name] = str(exc)[:140] or exc.__class__.__name__
            log.warning("%s failed: %s", provider.name, errors[provider.name])
            continue
        for tick in got.values():
            hub.ingest(tick)
        counts[provider.name] = len(got)
        missing -= set(got)

    if counts:
        hub.poll_source = max(counts, key=lambda k: counts[k])
        parts = [f"{n.upper()} {c}" for n, c in counts.items()]
        hub.poll_detail = f"Polled every {int(POLL_OPEN_SECONDS)}s during market hours ({', '.join(parts)} symbols)."
        hub.note = ""  # symbols nobody could price are reported in status["missing"], not as a banner
        if missing:
            log.warning("no source priced %d symbols: %s", len(missing), ", ".join(sorted(k[:-3] for k in missing if k.endswith('.NS'))[:20]))
        hub.updated_at = time.time()
    else:
        hub.poll_source = None
        hub.poll_detail = ""
        why = "; ".join(f"{k}: {v}" for k, v in errors.items()) or "no provider configured"
        hub.note = (
            f"No data source reachable ({why}). Check the backend's internet access, "
            "or set FYERS_APP_ID / FYERS_ACCESS_TOKEN."
        )
    return counts


async def poll_loop(providers: List[Any]) -> None:
    while True:
        if hub.fyers_healthy():
            await asyncio.sleep(5)
            continue
        try:
            await run_poll_cycle(providers)
        except Exception:  # noqa: BLE001
            log.exception("poll cycle crashed")
        await asyncio.sleep(POLL_OPEN_SECONDS if is_market_open() else POLL_CLOSED_SECONDS)


async def fetch_extra_tick(key: str) -> Optional[Dict[str, Any]]:
    """Live quote for one symbol outside the 172-stock universe: NSE first, Yahoo second."""
    symbol = key[:-3]
    try:
        tick = await asyncio.wait_for(nse.quote_one(symbol), timeout=15)
        if tick:
            return tick
    except Exception as exc:  # noqa: BLE001
        log.info("NSE quote for %s failed (%s); trying Yahoo", symbol, str(exc)[:80])
    KEY_TO_YAHOO.setdefault(key, key)
    try:
        got = await asyncio.wait_for(yahoo.fetch({key}), timeout=15)
        return got.get(key)
    except Exception as exc:  # noqa: BLE001
        log.info("Yahoo quote for %s failed: %s", symbol, str(exc)[:80])
        return None


async def extras_loop() -> None:
    """Keeps user-searched symbols fresh (every 10 s), independent of the main feed."""
    while True:
        await asyncio.sleep(10)
        for key in list(hub.extra):
            tick = await fetch_extra_tick(key)
            if tick:
                tick.pop("name", None)
                hub.ingest(tick)


async def analytics_loop() -> None:
    """Loads daily history in chunks and broadcasts after each chunk, so scores appear progressively."""
    items = list(STOCK_KEYS_FOR_HISTORY.items())
    while True:
        total = 0
        try:
            for i in range(0, len(items), 24):
                data = await history.fetch_many(dict(items[i : i + 24]))
                if data:
                    hub.analytics.update(data)
                    total += len(data)
                    await hub.broadcast({"type": "analytics", "data": data})
            if total:
                hub.analytics_note = ""
            else:
                hub.analytics_note = (
                    f"Price history could not be loaded ({history.last_error or 'no response'}). "
                    "Signals use today's price action only until it loads; the backend retries every 5 minutes."
                )
        except Exception:  # noqa: BLE001
            log.exception("analytics refresh crashed")
        await asyncio.sleep(ANALYTICS_REFRESH_SECONDS if hub.analytics else 300)


async def backtest_loop() -> None:
    """Re-runs the signal backtest on the candles the analytics loop has cached. CPU work runs off the event loop."""
    while True:
        await asyncio.sleep(60)
        if len(history.candle_cache) < 20:
            continue
        try:
            snapshot = dict(history.candle_cache)
            hub.backtest = await asyncio.to_thread(run_backtest, snapshot)
            log.info("backtest: %s", hub.backtest["verdict_text"][:120])
        except Exception:  # noqa: BLE001
            log.exception("backtest crashed")
        await asyncio.sleep(BACKTEST_REFRESH_SECONDS)


class RateLimiter:
    """Small in-memory sliding window per (client, bucket). Enough to stop a runaway script from hammering NSE through you."""

    def __init__(self) -> None:
        self.hits: Dict[tuple, List[float]] = {}

    def check(self, client: str, bucket: str, limit: int, window: float = 60.0) -> None:
        now = time.time()
        key = (client, bucket)
        recent = [t for t in self.hits.get(key, []) if now - t < window]
        if len(recent) >= limit:
            raise HTTPException(status_code=429, detail="Too many requests. Wait a minute and try again.")
        recent.append(now)
        self.hits[key] = recent
        if len(self.hits) > 5000:  # bound memory
            self.hits = {k: v for k, v in self.hits.items() if v and now - v[-1] < window}


limiter = RateLimiter()


def _client_id(request: Request) -> str:
    return request.client.host if request.client else "unknown"


async def require_key(request: Request) -> None:
    if not API_KEY:
        return
    given = request.headers.get("x-api-key", "") or request.query_params.get("key", "")
    if not hmac.compare_digest(given.encode(), API_KEY.encode()):
        raise HTTPException(status_code=401, detail="Missing or wrong API key.")


# --------------------------------------------------------------------------- #
# App wiring
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def lifespan(_: FastAPI):
    loop = asyncio.get_running_loop()
    tasks: List[asyncio.Task] = [
        asyncio.create_task(hub.flush_loop()),
        asyncio.create_task(hub.status_loop()),
        asyncio.create_task(extras_loop()),
    ]
    feed: Optional[FyersFeed] = None

    if FYERS_APP_ID and FYERS_ACCESS_TOKEN:
        hub.fyers_configured = True
        feed = FyersFeed(loop)
        tasks.append(asyncio.ensure_future(loop.run_in_executor(None, feed.load_snapshot_blocking)))
        feed.start()
    else:
        log.warning("Fyers credentials not set: using the NSE / Yahoo polling feeds.")

    tasks.append(asyncio.create_task(poll_loop([nse, yahoo])))
    tasks.append(asyncio.create_task(analytics_loop()))
    tasks.append(asyncio.create_task(backtest_loop()))
    if API_KEY:
        log.info("API key protection is ON")
    else:
        log.warning("MARKETMIND_API_KEY is not set: anyone who can reach this server can use it. Fine on localhost; set a key before exposing it.")

    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        if feed:
            feed.stop()
        for closer in (nse.close, yahoo.close, history.close, news.close):
            try:
                await closer()
            except Exception:  # noqa: BLE001
                pass


app = FastAPI(title="MarketMind", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
async def health() -> Dict[str, Any]:
    age = None if hub.last_tick_at == 0 else round(time.time() - hub.last_tick_at, 2)
    return {
        **hub.status(),
        "subscribed_symbols": len(ALL_FYERS_SYMBOLS),
        "symbols_with_data": len(hub.latest),
        "symbols_with_analytics": len(hub.analytics),
        "history_last_error": history.last_error,
        "history_symbols_cached": len(history.candle_cache),
        "backtest_ready": hub.backtest is not None,
        "news_last_error": news.last_error,
        "auth_required": bool(API_KEY),
        "extra_symbols": sorted(hub.extra),
        "clients": len(hub.clients),
        "seconds_since_last_change": age,
    }


@app.get("/api/v1/backtest", dependencies=[Depends(require_key)])
async def get_backtest(request: Request) -> Dict[str, Any]:
    limiter.check(_client_id(request), "backtest", 20)
    if hub.backtest is None:
        raise HTTPException(status_code=503, detail="The backtest is still waiting for price history to load. Try again in a few minutes.")
    return hub.backtest


@app.get("/api/v1/market/news/{symbol}", dependencies=[Depends(require_key)])
async def get_news(symbol: str, request: Request, name: str = "") -> Dict[str, Any]:
    limiter.check(_client_id(request), "news", 30)
    sym = symbol.strip().upper()
    if sym.endswith(".NS"):
        sym = sym[:-3]
    if not SYMBOL_RE.match(sym):
        raise HTTPException(status_code=400, detail="Use an NSE ticker such as ZENSARTECH or M&M.")
    items = await news.headlines(sym, name[:80])
    return {"symbol": f"{sym}.NS", "items": items, "error": news.last_error}


@app.get("/api/v1/market/lookup/{symbol}", dependencies=[Depends(require_key)])
async def lookup(symbol: str, request: Request) -> Dict[str, Any]:
    """Live quote + analytics for any NSE symbol. The symbol is then streamed to every connected browser."""
    limiter.check(_client_id(request), "lookup", 40)
    sym = symbol.strip().upper()
    if sym.endswith(".NS"):
        sym = sym[:-3]
    if not SYMBOL_RE.match(sym):
        raise HTTPException(status_code=400, detail="Use an NSE ticker such as ZENSARTECH or M&M.")
    key = f"{sym}.NS"
    if key not in ALL_KEYS and len(hub.extra) >= MAX_EXTRA and key not in hub.extra:
        raise HTTPException(status_code=429, detail=f"At most {MAX_EXTRA} extra symbols can be tracked.")

    tick = hub.latest.get(key) if key in ALL_KEYS else None
    name = sym
    if tick is None:
        tick = await fetch_extra_tick(key)
    if tick is None:
        raise HTTPException(status_code=404, detail=f"No live quote found for {sym} on NSE.")
    name = str(tick.pop("name", name))

    if key not in ALL_KEYS:
        hub.extra.add(key)
        KEY_TO_YAHOO.setdefault(key, key)
    hub.ingest(tick)

    ana = hub.analytics.get(key)
    if ana is None:
        try:
            ana = await asyncio.wait_for(history.analytics_for(key, sym), timeout=25)
        except Exception as exc:  # noqa: BLE001
            log.info("analytics for %s unavailable: %s", key, str(exc)[:80])
            ana = None
        if ana:
            hub.analytics[key] = ana
            await hub.broadcast({"type": "analytics", "data": {key: ana}})
    return {"key": key, "name": name, "tick": tick, "analytics": ana}


@app.websocket("/ws/market")
async def market_socket(ws: WebSocket) -> None:
    if API_KEY and not hmac.compare_digest(ws.query_params.get("key", "").encode(), API_KEY.encode()):
        await ws.close(code=1008)
        return
    if len(hub.clients) >= MAX_CLIENTS:
        await ws.close(code=1013)
        return
    await ws.accept()
    hub.clients.add(ws)
    try:
        await ws.send_text(json.dumps({"type": "hello", **hub.status()}))
        if hub.latest:
            await ws.send_text(json.dumps({"type": "snapshot", "data": hub.latest}, separators=(",", ":")))
        if hub.analytics:
            await ws.send_text(json.dumps({"type": "analytics", "data": hub.analytics}, separators=(",", ":")))
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            action = msg.get("action")
            if action == "ping":
                await ws.send_text('{"type":"pong"}')
            elif action == "track" and isinstance(msg.get("symbols"), list):
                for s in msg["symbols"][:MAX_EXTRA]:
                    key = str(s).upper()
                    base = key[:-3] if key.endswith(".NS") else key
                    if SYMBOL_RE.match(base) and f"{base}.NS" not in ALL_KEYS and len(hub.extra) < MAX_EXTRA:
                        hub.extra.add(f"{base}.NS")
                        KEY_TO_YAHOO.setdefault(f"{base}.NS", f"{base}.NS")
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        log.debug("client socket closed: %s", exc)
    finally:
        hub.clients.discard(ws)