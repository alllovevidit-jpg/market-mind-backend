import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ==========================================================================
   MarketMind — App.tsx (dark edition)
   Prices come only from the backend (Fyers / NSE / Yahoo). Quant scores, RSI,
   stop-losses and catalysts are computed from real daily price history that the
   backend sends; where history is missing the UI says so instead of guessing.
   ========================================================================== */

/* ----------------------------- Types & constants ------------------------- */

type Outlook = "Bullish" | "Neutral" | "Bearish";

interface Stock {
  symbol: string; // e.g. "RELIANCE.NS" (key shared with the backend)
  name: string;
  sector: string;
  latest_close: number; // unused placeholder: prices only ever come from the backend
  pct_change: number; // unused placeholder
  trajectory_outlook: Outlook; // unused placeholder
  sentiment_score: number; // unused placeholder
  custom?: boolean; // added through the Live Quant lookup
}

interface Quote {
  key: string;
  ltp: number;
  prevClose: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  ts: number; // epoch seconds
  y52h?: number; // 52-week high when the feed provides it
  y52l?: number;
  c30?: number; // 30-day % change when the feed provides it
}

interface WireTick {
  s: string;
  ltp: number;
  pc: number;
  ch: number;
  chp: number;
  o: number;
  h: number;
  l: number;
  v: number;
  t: number;
  y52h?: number;
  y52l?: number;
  c30?: number;
}

/** Analytics exactly as the backend sends them (short keys). */
interface AnaWire {
  r: number | null;
  s20: number | null;
  s50: number | null;
  atr: number | null;
  b: number | null;
  h: number | null;
  l: number | null;
  r30: number | null;
  mh?: number | null; // MACD histogram, % of price
  pb?: number | null; // Bollinger %B
  v?: number | null; // annualised volatility %
  r6?: number | null; // 6-month % change
  ch?: number | null; // Chandelier exit
  hist: [number, number][];
}

interface Analytics {
  rsi: number | null;
  sma20: number | null;
  sma50: number | null;
  atr: number | null;
  beta: number | null;
  hi52: number | null;
  lo52: number | null;
  ret30: number | null;
  macdHist: number | null;
  pctB: number | null;
  vol: number | null;
  ret6: number | null;
  chandelier: number | null;
  hist: [number, number][]; // [epoch seconds, close]
}

interface Holding {
  symbol: string;
  qty: number;
  avgPrice: number;
  peak: number; // highest price seen since entry (drives the trailing stop)
}

interface HistoryPoint {
  d: string; // IST date YYYY-MM-DD
  v: number; // portfolio market value
  i: number; // total invested at that moment
}

interface FeedState {
  source: string; // "fyers" | "nse" | "yahoo" | "none"
  label: string;
  detail: string;
  note: string;
  delayed: boolean;
  updatedAt: number;
  marketOpen: boolean;
  stale: boolean; // backend says nothing fresh has arrived during market hours
  missing: string[]; // universe stocks no source could price
  receivedAt: number; // browser clock (ms) of the last status message
}

interface CustomStock {
  symbol: string; // "ZENSARTECH.NS"
  name: string;
}

interface JournalEntry {
  t: number; // epoch ms
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  realized?: number; // profit or loss on a sale, before costs
}

type ConnStatus = "connecting" | "live" | "offline";
type SortKey = "default" | "gainers" | "losers" | "score" | "price" | "name";
type ViewMode = "board" | "list";
type SignalFilter = "all" | "watch" | "growth" | "sell";

const IST_OFFSET = 19800; // seconds; charts display IST
const TRAILING_STOP_PCT = 0.035;
const RISK_FREE_ANNUAL = 0.065;
const DEFAULT_RISK_BUDGET = 50000;
const LS_HOLDINGS = "marketmind.portfolio.v2";
const LS_HISTORY = "marketmind.portfolio.history.v2";
const LS_WATCH = "marketmind.watchlist.v2";
// First-run watchlist so the panel is never empty. Star or unstar anything; your own choices are saved from then on.
const STARTER_WATCH = ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS", "SBIN.NS"];
const LS_VIEW = "marketmind.view.v1";
const LS_CUSTOM = "marketmind.custom.v1";
const LS_RISK = "marketmind.riskbudget.v1";
const LS_JOURNAL = "marketmind.journal.v1";
const COST_PCT = 0.25; // assumed round-trip brokerage, taxes and slippage, in percent

const ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const API_KEY: string = ENV?.VITE_API_KEY ?? "";
const WS_BASE: string =
  ENV?.VITE_WS_URL ?? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:8000/ws/market`;
const WS_URL: string = API_KEY ? `${WS_BASE}?key=${encodeURIComponent(API_KEY)}` : WS_BASE;
const API_BASE: string = ENV?.VITE_API_URL ?? WS_BASE.replace(/^ws/, "http").replace(/\/ws\/market.*$/, "");

const INDICES: { key: string; label: string }[] = [
  { key: "NIFTY50", label: "Nifty 50" },
  { key: "BANKNIFTY", label: "Bank Nifty" },
  { key: "SENSEX", label: "Sensex" },
  { key: "FINNIFTY", label: "Fin Nifty" },
  { key: "MIDCPNIFTY", label: "Midcap Select" },
  { key: "NIFTYIT", label: "Nifty IT" },
  { key: "INDIAVIX", label: "India VIX" },
];

/* ------------------------------ Stock universe --------------------------- */

const B: Outlook = "Bullish";
const N: Outlook = "Neutral";
const R: Outlook = "Bearish";

const s = (
  symbol: string,
  name: string,
  sector: string,
  _referencePrice: number, // intentionally ignored: invented prices are never displayed
  trajectory_outlook: Outlook,
  sentiment_score: number
): Stock => ({ symbol, name, sector, latest_close: 0, pct_change: 0, trajectory_outlook, sentiment_score });

// NOTE: prices are NEVER taken from this file. latest_close / pct_change start at 0 and the UI shows
// "—" until a real quote arrives from the broker. outlook / sentiment are placeholders (not displayed).
const ULTIMATE_INDIAN_MARKET_UNIVERSE: Stock[] = [
  // ---- Banking (16)
  s("HDFCBANK.NS", "HDFC Bank", "Banking", 1000, B, 0.55),
  s("ICICIBANK.NS", "ICICI Bank", "Banking", 1400, B, 0.6),
  s("SBIN.NS", "State Bank of India", "Banking", 850, B, 0.45),
  s("KOTAKBANK.NS", "Kotak Mahindra Bank", "Banking", 2100, N, 0.2),
  s("AXISBANK.NS", "Axis Bank", "Banking", 1150, N, 0.3),
  s("INDUSINDBK.NS", "IndusInd Bank", "Banking", 800, R, -0.25),
  s("BANKBARODA.NS", "Bank of Baroda", "Banking", 250, B, 0.4),
  s("PNB.NS", "Punjab National Bank", "Banking", 110, N, 0.15),
  s("CANBK.NS", "Canara Bank", "Banking", 120, B, 0.35),
  s("UNIONBANK.NS", "Union Bank of India", "Banking", 140, N, 0.1),
  s("IDFCFIRSTB.NS", "IDFC First Bank", "Banking", 70, N, 0.05),
  s("FEDERALBNK.NS", "Federal Bank", "Banking", 200, B, 0.4),
  s("AUBANK.NS", "AU Small Finance Bank", "Banking", 800, N, 0.2),
  s("BANDHANBNK.NS", "Bandhan Bank", "Banking", 170, R, -0.3),
  s("YESBANK.NS", "Yes Bank", "Banking", 21, N, 0.0),
  s("INDIANB.NS", "Indian Bank", "Banking", 700, B, 0.45),
  // ---- Financial Services (15)
  s("BAJFINANCE.NS", "Bajaj Finance", "Financials", 1000, B, 0.5),
  s("BAJAJFINSV.NS", "Bajaj Finserv", "Financials", 2000, B, 0.4),
  s("HDFCLIFE.NS", "HDFC Life Insurance", "Financials", 750, N, 0.2),
  s("SBILIFE.NS", "SBI Life Insurance", "Financials", 1800, B, 0.45),
  s("ICICIPRULI.NS", "ICICI Prudential Life", "Financials", 650, N, 0.1),
  s("ICICIGI.NS", "ICICI Lombard", "Financials", 1900, B, 0.35),
  s("CHOLAFIN.NS", "Cholamandalam Investment", "Financials", 1600, B, 0.5),
  s("SHRIRAMFIN.NS", "Shriram Finance", "Financials", 650, B, 0.45),
  s("MUTHOOTFIN.NS", "Muthoot Finance", "Financials", 3300, B, 0.6),
  s("LICHSGFIN.NS", "LIC Housing Finance", "Financials", 580, N, 0.0),
  s("PFC.NS", "Power Finance Corp", "Financials", 400, N, 0.2),
  s("RECLTD.NS", "REC Ltd", "Financials", 370, N, 0.15),
  s("JIOFIN.NS", "Jio Financial Services", "Financials", 310, N, 0.1),
  s("SBICARD.NS", "SBI Cards", "Financials", 900, N, 0.05),
  s("HDFCAMC.NS", "HDFC Asset Management", "Financials", 5500, B, 0.5),
  // ---- IT (11)
  s("TCS.NS", "Tata Consultancy Services", "IT", 3100, N, 0.1),
  s("INFY.NS", "Infosys", "IT", 1550, N, 0.2),
  s("WIPRO.NS", "Wipro", "IT", 260, N, 0.0),
  s("HCLTECH.NS", "HCL Technologies", "IT", 1550, N, 0.25),
  s("TECHM.NS", "Tech Mahindra", "IT", 1500, B, 0.35),
  s("LTM.NS", "LTIMindtree (LTM)", "IT", 5200, N, 0.15),
  s("PERSISTENT.NS", "Persistent Systems", "IT", 6000, B, 0.55),
  s("COFORGE.NS", "Coforge", "IT", 1800, B, 0.5),
  s("MPHASIS.NS", "Mphasis", "IT", 2700, N, 0.2),
  s("OFSS.NS", "Oracle Financial Services", "IT", 8500, N, 0.1),
  s("KPITTECH.NS", "KPIT Technologies", "IT", 1200, B, 0.4),
  // ---- Auto (14)
  s("MARUTI.NS", "Maruti Suzuki", "Auto", 15500, B, 0.4),
  s("M&M.NS", "Mahindra & Mahindra", "Auto", 3500, B, 0.6),
  s("BAJAJ-AUTO.NS", "Bajaj Auto", "Auto", 9000, N, 0.2),
  s("EICHERMOT.NS", "Eicher Motors", "Auto", 6800, B, 0.5),
  s("HEROMOTOCO.NS", "Hero MotoCorp", "Auto", 5300, B, 0.35),
  s("TVSMOTOR.NS", "TVS Motor Company", "Auto", 3500, B, 0.55),
  s("ASHOKLEY.NS", "Ashok Leyland", "Auto", 145, B, 0.4),
  s("BOSCHLTD.NS", "Bosch Ltd", "Auto", 38000, N, 0.1),
  s("MOTHERSON.NS", "Samvardhana Motherson", "Auto", 110, N, 0.05),
  s("BHARATFORG.NS", "Bharat Forge", "Auto", 1300, N, 0.15),
  s("BALKRISIND.NS", "Balkrishna Industries", "Auto", 2500, R, -0.1),
  s("APOLLOTYRE.NS", "Apollo Tyres", "Auto", 480, N, 0.1),
  s("MRF.NS", "MRF Ltd", "Auto", 150000, N, 0.0),
  s("SONACOMS.NS", "Sona BLW Precision", "Auto", 480, N, 0.1),
  // ---- Energy & Power (16)
  s("RELIANCE.NS", "Reliance Industries", "Energy", 1450, B, 0.5),
  s("ONGC.NS", "ONGC", "Energy", 240, N, 0.1),
  s("IOC.NS", "Indian Oil Corp", "Energy", 160, N, 0.15),
  s("BPCL.NS", "Bharat Petroleum", "Energy", 330, N, 0.2),
  s("GAIL.NS", "GAIL (India)", "Energy", 180, N, 0.1),
  s("COALINDIA.NS", "Coal India", "Energy", 390, N, 0.05),
  s("NTPC.NS", "NTPC", "Power", 340, B, 0.35),
  s("POWERGRID.NS", "Power Grid Corp", "Power", 290, N, 0.2),
  s("TATAPOWER.NS", "Tata Power", "Power", 390, B, 0.4),
  s("ADANIGREEN.NS", "Adani Green Energy", "Power", 1000, N, 0.1),
  s("ADANIPOWER.NS", "Adani Power", "Power", 150, N, 0.15),
  s("NHPC.NS", "NHPC", "Power", 85, N, 0.05),
  s("PETRONET.NS", "Petronet LNG", "Energy", 280, N, 0.0),
  s("OIL.NS", "Oil India", "Energy", 420, N, 0.1),
  s("JSWENERGY.NS", "JSW Energy", "Power", 520, N, 0.1),
  s("HINDPETRO.NS", "Hindustan Petroleum", "Energy", 420, N, 0.2),
  // ---- Metals & Mining (10)
  s("TATASTEEL.NS", "Tata Steel", "Metals", 170, B, 0.4),
  s("JSWSTEEL.NS", "JSW Steel", "Metals", 1100, B, 0.35),
  s("HINDALCO.NS", "Hindalco Industries", "Metals", 750, B, 0.45),
  s("VEDL.NS", "Vedanta", "Metals", 480, B, 0.4),
  s("SAIL.NS", "Steel Authority of India", "Metals", 130, N, 0.1),
  s("NMDC.NS", "NMDC", "Metals", 75, N, 0.15),
  s("JINDALSTEL.NS", "Jindal Steel & Power", "Metals", 1000, B, 0.4),
  s("APLAPOLLO.NS", "APL Apollo Tubes", "Metals", 1750, B, 0.35),
  s("HINDZINC.NS", "Hindustan Zinc", "Metals", 480, N, 0.2),
  s("NATIONALUM.NS", "National Aluminium", "Metals", 220, B, 0.3),
  // ---- FMCG (11)
  s("HINDUNILVR.NS", "Hindustan Unilever", "FMCG", 2450, N, 0.1),
  s("ITC.NS", "ITC", "FMCG", 410, N, 0.2),
  s("NESTLEIND.NS", "Nestle India", "FMCG", 1250, N, 0.15),
  s("BRITANNIA.NS", "Britannia Industries", "FMCG", 5800, N, 0.2),
  s("TATACONSUM.NS", "Tata Consumer Products", "FMCG", 1100, B, 0.3),
  s("DABUR.NS", "Dabur India", "FMCG", 520, N, 0.0),
  s("GODREJCP.NS", "Godrej Consumer Products", "FMCG", 1200, N, 0.1),
  s("MARICO.NS", "Marico", "FMCG", 720, B, 0.3),
  s("COLPAL.NS", "Colgate-Palmolive India", "FMCG", 2300, R, -0.2),
  s("VBL.NS", "Varun Beverages", "FMCG", 480, B, 0.35),
  s("UNITDSPR.NS", "United Spirits", "FMCG", 1400, N, 0.15),
  // ---- Pharma & Healthcare (14)
  s("SUNPHARMA.NS", "Sun Pharmaceutical", "Pharma", 1700, B, 0.4),
  s("DRREDDY.NS", "Dr. Reddy's Laboratories", "Pharma", 1250, N, 0.1),
  s("CIPLA.NS", "Cipla", "Pharma", 1550, N, 0.2),
  s("DIVISLAB.NS", "Divi's Laboratories", "Pharma", 6200, B, 0.4),
  s("LUPIN.NS", "Lupin", "Pharma", 1950, B, 0.35),
  s("AUROPHARMA.NS", "Aurobindo Pharma", "Pharma", 1150, N, 0.1),
  s("TORNTPHARM.NS", "Torrent Pharmaceuticals", "Pharma", 3500, B, 0.4),
  s("ZYDUSLIFE.NS", "Zydus Lifesciences", "Pharma", 950, N, 0.05),
  s("ALKEM.NS", "Alkem Laboratories", "Pharma", 5000, N, 0.15),
  s("MANKIND.NS", "Mankind Pharma", "Pharma", 2400, N, 0.2),
  s("APOLLOHOSP.NS", "Apollo Hospitals", "Healthcare", 7500, B, 0.5),
  s("MAXHEALTH.NS", "Max Healthcare", "Healthcare", 1150, B, 0.45),
  s("FORTIS.NS", "Fortis Healthcare", "Healthcare", 900, B, 0.4),
  s("BIOCON.NS", "Biocon", "Pharma", 380, N, 0.05),
  // ---- Infrastructure, Capital Goods & Cement (16)
  s("LT.NS", "Larsen & Toubro", "Infrastructure", 3700, B, 0.5),
  s("ADANIENT.NS", "Adani Enterprises", "Infrastructure", 2300, N, 0.0),
  s("ADANIPORTS.NS", "Adani Ports & SEZ", "Infrastructure", 1400, B, 0.35),
  s("ULTRACEMCO.NS", "UltraTech Cement", "Cement", 12000, B, 0.4),
  s("GRASIM.NS", "Grasim Industries", "Cement", 2700, N, 0.2),
  s("AMBUJACEM.NS", "Ambuja Cements", "Cement", 570, N, 0.1),
  s("SHREECEM.NS", "Shree Cement", "Cement", 28000, N, 0.05),
  s("ACC.NS", "ACC Ltd", "Cement", 1850, N, 0.0),
  s("SIEMENS.NS", "Siemens Ltd", "Capital Goods", 3200, N, 0.2),
  s("ABB.NS", "ABB India", "Capital Goods", 5200, N, 0.15),
  s("HAL.NS", "Hindustan Aeronautics", "Defence", 4400, B, 0.55),
  s("BEL.NS", "Bharat Electronics", "Defence", 400, B, 0.5),
  s("BHEL.NS", "Bharat Heavy Electricals", "Capital Goods", 240, B, 0.3),
  s("CUMMINSIND.NS", "Cummins India", "Capital Goods", 3800, B, 0.4),
  s("POLYCAB.NS", "Polycab India", "Capital Goods", 7500, B, 0.45),
  s("HAVELLS.NS", "Havells India", "Capital Goods", 1500, N, 0.15),
  // ---- Realty (5)
  s("DLF.NS", "DLF", "Realty", 750, N, 0.2),
  s("GODREJPROP.NS", "Godrej Properties", "Realty", 2100, N, 0.15),
  s("OBEROIRLTY.NS", "Oberoi Realty", "Realty", 1750, N, 0.1),
  s("LODHA.NS", "Macrotech Developers", "Realty", 1200, B, 0.3),
  s("PRESTIGE.NS", "Prestige Estates", "Realty", 1650, B, 0.3),
  // ---- Consumer & Retail (13)
  s("TITAN.NS", "Titan Company", "Consumer", 3600, B, 0.5),
  s("ASIANPAINT.NS", "Asian Paints", "Consumer", 2400, N, 0.0),
  s("ETERNAL.NS", "Eternal (Zomato)", "Consumer", 320, B, 0.45),
  s("TRENT.NS", "Trent", "Consumer", 4800, N, 0.2),
  s("DMART.NS", "Avenue Supermarts", "Consumer", 4200, N, 0.1),
  s("NYKAA.NS", "FSN E-Commerce (Nykaa)", "Consumer", 230, N, 0.15),
  s("PAYTM.NS", "One 97 Communications", "Consumer", 1250, B, 0.35),
  s("POLICYBZR.NS", "PB Fintech", "Consumer", 1800, B, 0.4),
  s("IRCTC.NS", "IRCTC", "Consumer", 750, N, 0.05),
  s("INDIGO.NS", "InterGlobe Aviation", "Consumer", 5800, B, 0.5),
  s("PIDILITIND.NS", "Pidilite Industries", "Consumer", 3000, N, 0.15),
  s("BERGEPAINT.NS", "Berger Paints", "Consumer", 520, N, 0.0),
  s("PAGEIND.NS", "Page Industries", "Consumer", 45000, N, 0.1),
  // ---- Consumer Durables (3)
  s("DIXON.NS", "Dixon Technologies", "Durables", 15000, B, 0.45),
  s("VOLTAS.NS", "Voltas", "Durables", 1400, N, 0.1),
  s("BLUESTARCO.NS", "Blue Star", "Durables", 1800, N, 0.2),
  // ---- Telecom (4)
  s("BHARTIARTL.NS", "Bharti Airtel", "Telecom", 1950, B, 0.55),
  s("IDEA.NS", "Vodafone Idea", "Telecom", 8, R, -0.2),
  s("INDUSTOWER.NS", "Indus Towers", "Telecom", 380, N, 0.15),
  s("TATACOMM.NS", "Tata Communications", "Telecom", 1700, N, 0.1),
  // ---- Chemicals (6)
  s("SRF.NS", "SRF Ltd", "Chemicals", 3000, B, 0.3),
  s("UPL.NS", "UPL", "Chemicals", 650, N, 0.1),
  s("PIIND.NS", "PI Industries", "Chemicals", 3700, N, 0.1),
  s("DEEPAKNTR.NS", "Deepak Nitrite", "Chemicals", 1900, R, -0.15),
  s("TATACHEM.NS", "Tata Chemicals", "Chemicals", 950, N, 0.0),
  s("NAVINFLUOR.NS", "Navin Fluorine", "Chemicals", 5000, B, 0.35),
  // ---- Defence & Railway PSU (5)
  s("IRFC.NS", "Indian Railway Finance Corp", "PSU", 125, N, 0.1),
  s("RVNL.NS", "Rail Vikas Nigam", "PSU", 360, N, 0.15),
  s("MAZDOCK.NS", "Mazagon Dock Shipbuilders", "Defence", 2800, B, 0.45),
  s("COCHINSHIP.NS", "Cochin Shipyard", "Defence", 1700, B, 0.4),
  s("BDL.NS", "Bharat Dynamics", "Defence", 1600, B, 0.45),
  // ---- New-age, Exchanges & Capital Markets (10)
  s("LICI.NS", "Life Insurance Corp", "Financials", 900, N, 0.15),
  s("SWIGGY.NS", "Swiggy", "Consumer", 400, N, 0.1),
  s("HYUNDAI.NS", "Hyundai Motor India", "Auto", 2300, N, 0.2),
  s("NAUKRI.NS", "Info Edge (Naukri)", "Consumer", 1350, N, 0.15),
  s("MCX.NS", "Multi Commodity Exchange", "Capital Markets", 9000, B, 0.5),
  s("BSE.NS", "BSE Ltd", "Capital Markets", 2500, B, 0.55),
  s("CDSL.NS", "CDSL", "Capital Markets", 1500, B, 0.35),
  s("ANGELONE.NS", "Angel One", "Capital Markets", 2600, N, 0.15),
  s("IEX.NS", "Indian Energy Exchange", "Capital Markets", 140, N, 0.05),
  s("TATAELXSI.NS", "Tata Elxsi", "IT", 5500, N, 0.1),
  // ---- Misc (3)
  s("DELHIVERY.NS", "Delhivery", "Logistics", 420, N, 0.1),
  s("JUBLFOOD.NS", "Jubilant FoodWorks", "Consumer", 600, N, 0.15),
  s("KALYANKJIL.NS", "Kalyan Jewellers", "Consumer", 500, B, 0.35),
];

/* ------------------------- Formatting helpers ---------------------------- */

const fmtINR = (n: number): string =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const fmtCompact = (n: number): string => {
  if (!isFinite(n) || n <= 0) return "—";
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return String(Math.round(n));
};

const tickerOf = (symbol: string): string => symbol.replace(/\.NS$/, "");

const istDate = (): string => new Date(Date.now() + IST_OFFSET * 1000).toISOString().slice(0, 10);

/* ----------------------- Portfolio math (complete) ----------------------- */

interface PortfolioRow {
  holding: Holding;
  stock: Stock | undefined;
  ltp: number;
  prevClose: number;
  invested: number;
  value: number;
  pnl: number;
  pnlPct: number;
  stopPrice: number;
  stopHit: boolean;
  hasLive: boolean;
}

interface PortfolioSummary {
  rows: PortfolioRow[];
  invested: number;
  value: number;
  pnl: number;
  pnlPct: number;
  dayPnl: number;
  hasLive: boolean;
}

/** Live P&L, invested capital, day P&L and 3.5% trailing stops for every holding. */
function summarizePortfolio(
  holdings: Holding[],
  quotes: Record<string, Quote>,
  universe: Stock[]
): PortfolioSummary {
  const bySymbol = new Map(universe.map((st) => [st.symbol, st] as const));
  const rows: PortfolioRow[] = holdings.map((h) => {
    const stock = bySymbol.get(h.symbol);
    const q = quotes[h.symbol];
    const ltp = q?.ltp ?? h.avgPrice;
    const prevClose = q?.prevClose && q.prevClose > 0 ? q.prevClose : ltp;
    const invested = h.qty * h.avgPrice;
    const value = h.qty * ltp;
    const pnl = value - invested;
    const peak = Math.max(h.peak, ltp, h.avgPrice);
    const stopPrice = peak * (1 - TRAILING_STOP_PCT);
    return {
      holding: h,
      stock,
      ltp,
      prevClose,
      invested,
      value,
      pnl,
      pnlPct: invested > 0 ? (pnl / invested) * 100 : 0,
      stopPrice,
      stopHit: ltp <= stopPrice,
      hasLive: Boolean(q),
    };
  });
  const invested = rows.reduce((a, r) => a + r.invested, 0);
  const value = rows.reduce((a, r) => a + r.value, 0);
  const pnl = value - invested;
  const dayPnl = rows.reduce((a, r) => a + r.holding.qty * (r.ltp - r.prevClose), 0);
  return {
    rows,
    invested,
    value,
    pnl,
    pnlPct: invested > 0 ? (pnl / invested) * 100 : 0,
    dayPnl,
    hasLive: rows.some((r) => r.hasLive),
  };
}

/**
 * Builds a cash-flow-adjusted daily return series from stored snapshots.
 * return_t = (V_t - V_{t-1} - (I_t - I_{t-1})) / V_{t-1}
 * so that buying/selling shares does not show up as fake performance.
 */
function dailyReturns(history: HistoryPoint[]): number[] {
  const out: number[] = [];
  for (let k = 1; k < history.length; k++) {
    const prev = history[k - 1];
    const cur = history[k];
    if (prev.v > 0) out.push((cur.v - prev.v - (cur.i - prev.i)) / prev.v);
  }
  return out;
}

/** Annualised Sharpe ratio (252 trading days, 6.5% risk-free). null until enough data. */
function computeSharpeRatio(history: HistoryPoint[]): number | null {
  const rets = dailyReturns(history);
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  const rfDaily = Math.pow(1 + RISK_FREE_ANNUAL, 1 / 252) - 1;
  return ((mean - rfDaily) / sd) * Math.sqrt(252);
}

/** Maximum drawdown (%, negative number) of the compounded NAV curve. null with <2 points. */
function computeMaxDrawdown(history: HistoryPoint[]): number | null {
  const rets = dailyReturns(history);
  if (rets.length < 1) return null;
  let nav = 100;
  let peak = 100;
  let worst = 0;
  for (const r of rets) {
    nav *= 1 + r;
    if (nav > peak) peak = nav;
    const dd = (nav - peak) / peak;
    if (dd < worst) worst = dd;
  }
  return worst * 100;
}

/* ------------------- Chart data bus (outside of React) ------------------- */

interface ChartPoint {
  time: number;
  value: number;
}

const HISTORY_CAP = 4000;
const tickHistory = new Map<string, ChartPoint[]>();
const chartListeners = new Map<string, Set<(p: ChartPoint) => void>>();

function pushChartPoint(key: string, ts: number, value: number): void {
  const time = Math.floor(ts) + IST_OFFSET;
  let arr = tickHistory.get(key);
  if (!arr) {
    arr = [];
    tickHistory.set(key, arr);
  }
  const last = arr[arr.length - 1];
  if (last && time < last.time) return; // keep time strictly ascending
  if (last && time === last.time) {
    last.value = value; // same second: replace
  } else {
    arr.push({ time, value });
    if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP);
  }
  const point: ChartPoint = { time, value };
  chartListeners.get(key)?.forEach((fn) => fn(point));
}

function subscribeChart(key: string, fn: (p: ChartPoint) => void): () => void {
  let set = chartListeners.get(key);
  if (!set) {
    set = new Set();
    chartListeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
  };
}

/* --------------------------- Persistent state ---------------------------- */

function usePersistentState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue];
}

/* ------------------------------ Quant engine ------------------------------- */
/* Rule-based technical scoring from real data. Not a prediction and not advice. */

const GROUP_ORDER = [
  "Searched",
  "New-Age Tech",
  "IT & Tech",
  "Banking & Finance",
  "Energy & Infra",
  "Auto & Metals",
  "Consumer & FMCG",
  "Pharma & Healthcare",
];

const NEW_AGE = new Set([
  "ETERNAL.NS",
  "SWIGGY.NS",
  "NYKAA.NS",
  "PAYTM.NS",
  "POLICYBZR.NS",
  "NAUKRI.NS",
  "DELHIVERY.NS",
]);

const SECTOR_GROUP: Record<string, string> = {
  IT: "IT & Tech",
  Telecom: "IT & Tech",
  Banking: "Banking & Finance",
  Financials: "Banking & Finance",
  "Capital Markets": "Banking & Finance",
  Energy: "Energy & Infra",
  Power: "Energy & Infra",
  Infrastructure: "Energy & Infra",
  Cement: "Energy & Infra",
  "Capital Goods": "Energy & Infra",
  Defence: "Energy & Infra",
  PSU: "Energy & Infra",
  Realty: "Energy & Infra",
  Logistics: "Energy & Infra",
  Auto: "Auto & Metals",
  Metals: "Auto & Metals",
  Chemicals: "Auto & Metals",
  FMCG: "Consumer & FMCG",
  Consumer: "Consumer & FMCG",
  Durables: "Consumer & FMCG",
  Pharma: "Pharma & Healthcare",
  Healthcare: "Pharma & Healthcare",
};

const groupOf = (st: Stock): string => {
  if (st.custom) return "Searched";
  if (NEW_AGE.has(st.symbol)) return "New-Age Tech";
  return SECTOR_GROUP[st.sector] ?? "Other";
};

type Verdict = "STRONG BUY" | "ACCUMULATE" | "HOLD" | "SELL / BOOK PROFIT";

interface Signal {
  score: number; // 1..99
  verdict: Verdict;
  rsi: number | null;
  stop: number; // ATR-based protective stop (2 x ATR below price), else 3.5% below
  stopBasis: string;
  catalysts: string[];
  atr: number | null; // average daily range, when history is loaded
  target: number; // take-profit: 8% above the price
  conviction: string; // "High Conviction" or "Live Quant Flow"
  partial: boolean; // true when only today's price action was available (no daily history yet)
}

const TARGET_PCT = 0.08; // automated take-profit level
const HARD_STOP_PCT = 0.05; // hard stop shown on every card

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const fromAnaWire = (a: AnaWire): Analytics => ({
  rsi: a.r,
  sma20: a.s20,
  sma50: a.s50,
  atr: a.atr,
  beta: a.b,
  hi52: a.h,
  lo52: a.l,
  ret30: a.r30,
  macdHist: a.mh ?? null,
  pctB: a.pb ?? null,
  vol: a.v ?? null,
  ret6: a.r6 ?? null,
  chandelier: a.ch ?? null,
  hist: a.hist ?? [],
});

const isBuy = (v: Verdict): boolean => v === "STRONG BUY" || v === "ACCUMULATE";
const isSell = (v: Verdict): boolean => v === "SELL / BOOK PROFIT";
const verdictShort = (v: Verdict): string => (v === "SELL / BOOK PROFIT" ? "SELL" : v);
const verdictClass = (v: Verdict): string =>
  v === "STRONG BUY" ? "v-strong" : v === "ACCUMULATE" ? "v-accum" : v === "HOLD" ? "v-hold" : "v-sell";

function computeSignal(q: Quote | undefined, a: Analytics | undefined): Signal | null {
  if (!q || q.ltp <= 0) return null;
  const price = q.ltp;
  const hi52 = a?.hi52 ?? q.y52h ?? null;
  const lo52 = a?.lo52 ?? q.y52l ?? null;
  const ret30 = a?.ret30 ?? q.c30 ?? null;
  const rsi = a?.rsi ?? null;
  const sma20 = a?.sma20 ?? null;
  const sma50 = a?.sma50 ?? null;
  if (rsi === null && sma50 === null && ret30 === null) return preliminarySignal(q, hi52, lo52);

  const pos52 = hi52 !== null && lo52 !== null && hi52 > lo52 ? (price - lo52) / (hi52 - lo52) : null;

  let s = 50;
  if (sma50 !== null) s += price > sma50 ? 12 : -12;
  if (sma20 !== null) s += price > sma20 ? 6 : -6;
  if (rsi !== null) {
    if (rsi >= 75) s -= 8;
    else if (rsi >= 60) s += 8;
    else if (rsi >= 45) s += 4;
    else if (rsi >= 30) s -= 4;
    else s -= 6;
  }
  if (ret30 !== null) s += clamp(ret30, -20, 20) * 0.7;
  s += clamp(q.changePct, -4, 4) * 1.5;
  if (pos52 !== null) {
    if (pos52 >= 0.85) s += 5;
    else if (pos52 <= 0.15) s -= 6;
  }
  const score = Math.round(clamp(s, 1, 99));

  const bookProfit = rsi !== null && rsi >= 75 && (ret30 ?? 0) >= 8;
  const verdict: Verdict = bookProfit
    ? "SELL / BOOK PROFIT"
    : score >= 72
      ? "STRONG BUY"
      : score >= 58
        ? "ACCUMULATE"
        : score >= 42
          ? "HOLD"
          : "SELL / BOOK PROFIT";

  const catalysts: string[] = [];
  if (hi52 !== null && price >= hi52 * 0.98) catalysts.push(`Trading near its 52-week high of ₹${fmtINR(hi52)}`);
  else if (lo52 !== null && price <= lo52 * 1.03) catalysts.push(`Trading near its 52-week low of ₹${fmtINR(lo52)}`);
  if (rsi !== null && rsi >= 70) catalysts.push(`Overbought: RSI at ${rsi.toFixed(0)}`);
  else if (rsi !== null && rsi <= 30) catalysts.push(`Oversold: RSI at ${rsi.toFixed(0)}`);
  if (sma20 !== null && sma50 !== null) {
    if (price > sma20 && price > sma50) catalysts.push("Uptrend: above its 20-day and 50-day averages");
    else if (price < sma20 && price < sma50) catalysts.push("Downtrend: below its 20-day and 50-day averages");
  }
  if (ret30 !== null && Math.abs(ret30) >= 10) {
    catalysts.push(`${ret30 > 0 ? "Up" : "Down"} ${Math.abs(ret30).toFixed(1)}% in the last month`);
  }
  if (q.prevClose > 0 && q.open > 0) {
    const gap = ((q.open - q.prevClose) / q.prevClose) * 100;
    if (Math.abs(gap) >= 1.5) catalysts.push(`Gapped ${gap > 0 ? "up" : "down"} ${Math.abs(gap).toFixed(1)}% at the open`);
  }
  if (Math.abs(q.changePct) >= 3) catalysts.push(`Sharp move today: ${fmtPct(q.changePct)}`);

  const atr = a?.atr ?? null;
  const stop = price * (1 - HARD_STOP_PCT);
  const conviction = score >= 72 || score <= 28 ? "High Conviction" : "Live Quant Flow";

  return {
    score,
    verdict,
    rsi,
    stop,
    stopBasis: "5% hard stop below the price",
    atr,
    target: price * (1 + TARGET_PCT),
    conviction,
    catalysts: catalysts.slice(0, 3),
    partial: false,
  };
}

/** Used until daily history arrives: reads only today's move and where price sits in today's range. */
function preliminarySignal(q: Quote, hi52: number | null, lo52: number | null): Signal {
  const price = q.ltp;
  const dayPos = q.high > q.low ? (price - q.low) / (q.high - q.low) : 0.5;
  let s = 50 + clamp(q.changePct, -5, 5) * 4 + (dayPos - 0.5) * 12;
  if (hi52 !== null && lo52 !== null && hi52 > lo52) {
    const pos = (price - lo52) / (hi52 - lo52);
    if (pos >= 0.85) s += 4;
    else if (pos <= 0.15) s -= 4;
  }
  const score = Math.round(clamp(s, 8, 92));
  // Never "STRONG BUY" on one day of data: the best a preliminary read can say is ACCUMULATE.
  const verdict: Verdict = score >= 62 ? "ACCUMULATE" : score <= 38 ? "SELL / BOOK PROFIT" : "HOLD";
  const catalysts: string[] = [];
  if (Math.abs(q.changePct) >= 2) catalysts.push(`${q.changePct > 0 ? "Up" : "Down"} ${Math.abs(q.changePct).toFixed(1)}% in the latest session`);
  if (dayPos >= 0.85 && q.high > q.low) catalysts.push("Closing near the top of the day's range");
  else if (dayPos <= 0.15 && q.high > q.low) catalysts.push("Closing near the bottom of the day's range");
  if (q.prevClose > 0 && q.open > 0) {
    const gap = ((q.open - q.prevClose) / q.prevClose) * 100;
    if (Math.abs(gap) >= 1.5) catalysts.push(`Gapped ${gap > 0 ? "up" : "down"} ${Math.abs(gap).toFixed(1)}% at the open`);
  }
  if (hi52 !== null && price >= hi52 * 0.98) catalysts.push(`Trading near its 52-week high of ₹${fmtINR(hi52)}`);
  else if (lo52 !== null && price <= lo52 * 1.03) catalysts.push(`Trading near its 52-week low of ₹${fmtINR(lo52)}`);
  return {
    score,
    verdict,
    rsi: null,
    stop: price * (1 - HARD_STOP_PCT),
    stopBasis: "5% hard stop below the price",
    atr: null,
    target: price * (1 + TARGET_PCT),
    conviction: "Live Quant Flow",
    catalysts: catalysts.slice(0, 3),
    partial: true,
  };
}

interface EntryEval {
  tone: "good" | "ok" | "bad" | "none";
  text: string;
}

function evaluateEntry(avg: number, a: Analytics | undefined, q: Quote | undefined): EntryEval {
  const hi = a?.hi52 ?? q?.y52h ?? null;
  const lo = a?.lo52 ?? q?.y52l ?? null;
  if (hi === null || lo === null || hi <= lo) return { tone: "none", text: "Entry check needs the 52-week range, which is not loaded yet" };
  const pos = (avg - lo) / (hi - lo);
  if (pos <= 0.35) return { tone: "good", text: "🟢 Excellent entry: bought in the lower third of the 52-week range" };
  if (pos <= 0.65) return { tone: "ok", text: "🟡 Fair entry: bought in the middle of the 52-week range" };
  return { tone: "bad", text: "🔴 Suboptimal entry: bought in the upper third of the 52-week range" };
}

function exitAdvice(row: PortfolioRow, sig: Signal | null): { tone: "good" | "ok" | "bad"; text: string } {
  if (row.stopHit) return { tone: "bad", text: "Exit: the price is below the trailing stop. Protect what is left." };
  if (sig && isSell(sig.verdict)) {
    return row.pnl > 0
      ? { tone: "bad", text: "Consider booking profit: the system signal turned to sell." }
      : { tone: "bad", text: "Consider exiting: the system signal turned to sell." };
  }
  if (sig && isBuy(sig.verdict)) return { tone: "good", text: "Hold. The signal is still positive; the trailing stop does the protecting." };
  return { tone: "ok", text: "Hold and watch. No exit signal right now." };
}

function protectionStatus(row: PortfolioRow): string {
  if (row.stopPrice > row.holding.avgPrice) return "🔒 Trailing stop active: gains are being locked in";
  return "Trailing stop sits below your cost: it limits loss but does not lock in profit yet";
}

/** Value-weighted beta against NIFTY 50, using only holdings whose beta is known. */
function portfolioBeta(rows: PortfolioRow[], an: Record<string, Analytics>): number | null {
  let weight = 0;
  let sum = 0;
  for (const r of rows) {
    const b = an[r.holding.symbol]?.beta;
    if (b === null || b === undefined) continue;
    sum += b * r.value;
    weight += r.value;
  }
  return weight > 0 ? sum / weight : null;
}

/* ------------------------- WebSocket market feed ------------------------- */

const fromWire = (w: WireTick): Quote => ({
  key: w.s,
  ltp: w.ltp,
  prevClose: w.pc,
  change: w.ch,
  changePct: w.chp,
  open: w.o,
  high: w.h,
  low: w.l,
  volume: w.v,
  ts: w.t,
  y52h: w.y52h,
  y52l: w.y52l,
  c30: w.c30,
});

const INITIAL_FEED: FeedState = {
  source: "none",
  label: "Connecting",
  detail: "",
  note: "",
  delayed: false,
  updatedAt: 0,
  marketOpen: false,
  stale: false,
  missing: [],
  receivedAt: 0,
};

interface LookupResult {
  key: string;
  name: string;
  tick: WireTick;
  analytics: AnaWire | null;
}

function useMarketSocket(customKeys: string[]) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [analytics, setAnalytics] = useState<Record<string, Analytics>>({});
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [feed, setFeed] = useState<FeedState>(INITIAL_FEED);
  const pending = useRef<Record<string, Quote>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const customRef = useRef<string[]>(customKeys);
  customRef.current = customKeys;

  const ingestWire = useCallback((w: WireTick) => {
    const q = fromWire(w);
    pending.current[q.key] = q;
    pushChartPoint(q.key, q.ts, q.ltp);
  }, []);

  const mergeAnalytics = useCallback((data: Record<string, AnaWire>) => {
    const mapped: Record<string, Analytics> = {};
    for (const [k, v] of Object.entries(data)) mapped[k] = fromAnaWire(v);
    setAnalytics((prev) => ({ ...prev, ...mapped }));
  }, []);

  /** Used by the Live Quant lookup so the new card fills in immediately. */
  const ingestExternal = useCallback(
    (result: LookupResult) => {
      ingestWire(result.tick);
      if (result.analytics) mergeAnalytics({ [result.key]: result.analytics });
    },
    [ingestWire, mergeAnalytics]
  );

  const track = useCallback((keys: string[]) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ action: "track", symbols: keys }));
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByUs = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // Charts are fed immediately; React state is flushed at 4 Hz so 170+ symbols never swamp the renderer.
    const flushTimer = setInterval(() => {
      const batch = pending.current;
      if (Object.keys(batch).length === 0) return;
      pending.current = {};
      setQuotes((prev) => ({ ...prev, ...batch }));
    }, 250);

    const applyStatus = (m: Record<string, unknown>) => {
      setFeed({
        source: String(m.source ?? "none"),
        label: String(m.label ?? ""),
        detail: String(m.detail ?? ""),
        note: String(m.note ?? ""),
        delayed: Boolean(m.delayed),
        updatedAt: Number(m.updatedAt ?? 0),
        marketOpen: Boolean(m.marketOpen),
        stale: Boolean(m.stale),
        missing: Array.isArray(m.missing) ? (m.missing as unknown[]).map(String) : [],
        receivedAt: Date.now(),
      });
    };

    const scheduleRetry = () => {
      retryTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** attempt++));
    };

    const connect = () => {
      setStatus("connecting");
      try {
        ws = new WebSocket("wss://market-mind-backend-aipk.onrender.com/ws/market");
      } catch (err) {
        console.error("MarketMind: WebSocket could not be created", WS_URL, err);
        setStatus("offline");
        scheduleRetry();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus("live");
        if (customRef.current.length > 0) {
          ws?.send(JSON.stringify({ action: "track", symbols: customRef.current }));
        }
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        let msg: { type: string; data?: unknown } & Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "hello" || msg.type === "status") applyStatus(msg);
        else if (msg.type === "snapshot") for (const w of Object.values(msg.data as Record<string, WireTick>)) ingestWire(w);
        else if (msg.type === "ticks") for (const w of msg.data as WireTick[]) ingestWire(w);
        else if (msg.type === "analytics") mergeAnalytics(msg.data as Record<string, AnaWire>);
      };

      ws.onerror = () => ws?.close();

      ws.onclose = () => {
        if (closedByUs) return;
        setStatus("offline");
        scheduleRetry();
      };
    };

    connect();
    return () => {
      closedByUs = true;
      clearInterval(flushTimer);
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [ingestWire, mergeAnalytics]);

  return { quotes, analytics, status, feed, ingestExternal, track };
}

async function lookupSymbol(symbol: string): Promise<LookupResult> {
  return apiGet<LookupResult>(`/api/v1/market/lookup/${encodeURIComponent(symbol)}`);
}
/* ------------------------------ Price chart -------------------------------- */
/* Dependency-free canvas chart. "live" plots ticks received since the page opened;
   "3m" plots real daily closes from the backend. Both can draw a dashed stop-loss line.
   Repaints at most once per animation frame, no animation, so nothing tears. */

type ChartMode = "live" | "hist";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const PriceChart = memo(function PriceChart({
  symbolKey,
  mode,
  hist,
  up,
  stop,
}: {
  symbolKey: string;
  mode: ChartMode;
  hist: [number, number][];
  up: boolean;
  stop: number | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopRef = useRef<number | null>(stop);
  const scheduleRef = useRef<() => void>(() => undefined);
  stopRef.current = stop;
  const [hasData, setHasData] = useState<boolean>(() =>
    mode === "live" ? (tickHistory.get(symbolKey)?.length ?? 0) > 0 : hist.length > 1
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const color = up ? "#00f5a0" : "#ff4d7d";
    const fillTop = up ? "rgba(0,245,160,0.28)" : "rgba(255,77,125,0.28)";
    const fillBottom = up ? "rgba(0,245,160,0)" : "rgba(255,77,125,0)";
    const padL = 10;
    const padR = 72;
    const padT = 14;
    const padB = 26;
    let raf = 0;
    let hoverX: number | null = null;

    const points = (): ChartPoint[] =>
      mode === "live" ? tickHistory.get(symbolKey) ?? [] : hist.map(([t, v]) => ({ time: t + IST_OFFSET, value: v }));

    const label = (t: number): string => {
      const iso = new Date(t * 1000).toISOString();
      return mode === "live" ? iso.slice(11, 19) : `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
    };

    const draw = () => {
      raf = 0;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      const pxW = Math.round(w * dpr);
      const pxH = Math.round(h * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const pts = points();
      if (pts.length === 0) return;
      const stopLevel = stopRef.current;

      const pw = w - padL - padR;
      const ph = h - padT - padB;
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pts) {
        if (p.value < lo) lo = p.value;
        if (p.value > hi) hi = p.value;
      }
      if (stopLevel !== null && stopLevel > 0) lo = Math.min(lo, stopLevel);
      if (hi === lo) {
        const pad = Math.abs(hi) * 0.001 || 1;
        hi += pad;
        lo -= pad;
      }
      const margin = (hi - lo) * 0.08;
      lo -= margin;
      hi += margin;
      const t0 = pts[0].time;
      let t1 = pts[pts.length - 1].time;
      if (t1 === t0) t1 = t0 + 1;
      const X = (t: number) => padL + ((t - t0) / (t1 - t0)) * pw;
      const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * ph;

      ctx.font = "11px 'DM Sans', system-ui, sans-serif";
      ctx.lineWidth = 1;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const decimals = hi - lo < 5 ? 2 : hi - lo < 50 ? 1 : 0;
      for (let i = 0; i <= 4; i++) {
        const v = lo + ((hi - lo) * i) / 4;
        const y = Math.round(Y(v)) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        ctx.fillStyle = "#8c97b4";
        ctx.fillText(v.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }), w - padR + 8, y);
      }

      // price line + gradient area
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = X(p.time);
        const y = Y(p.value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.lineTo(X(pts[pts.length - 1].time), padT + ph);
      ctx.lineTo(X(t0), padT + ph);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padT, 0, padT + ph);
      grad.addColorStop(0, fillTop);
      grad.addColorStop(1, fillBottom);
      ctx.fillStyle = grad;
      ctx.fill();

      // stop-loss line
      if (stopLevel !== null && stopLevel > 0) {
        const sy = Y(stopLevel);
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = "#ff4d7d";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(padL, sy);
        ctx.lineTo(w - padR, sy);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = "#ff4d7d";
        ctx.textAlign = "left";
        ctx.fillText(`Stop ${fmtINR(stopLevel)}`, padL + 4, sy - 9);
      }

      // time axis
      ctx.fillStyle = "#8c97b4";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(label(t0), padL, h - padB + 9);
      ctx.textAlign = "center";
      ctx.fillText(label((t0 + t1) / 2), padL + pw / 2, h - padB + 9);
      ctx.textAlign = "right";
      ctx.fillText(label(t1), w - padR, h - padB + 9);

      // last price marker + tag
      const last = pts[pts.length - 1];
      const lx = X(last.time);
      const ly = Y(last.value);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(w - padR + 3, ly - 9, padR - 5, 18);
      ctx.fillStyle = "#0a0e1a";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(fmtINR(last.value), w - padR + 7, ly);

      // crosshair
      if (hoverX !== null && hoverX >= padL && hoverX <= w - padR) {
        const target = t0 + ((hoverX - padL) / pw) * (t1 - t0);
        let a = 0;
        let b = pts.length - 1;
        while (a < b) {
          const mid = (a + b) >> 1;
          if (pts[mid].time < target) a = mid + 1;
          else b = mid;
        }
        if (a > 0 && Math.abs(pts[a - 1].time - target) < Math.abs(pts[a].time - target)) a -= 1;
        const hp = pts[a];
        const hx = X(hp.time);
        const hy = Y(hp.value);
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx + 0.5, padT);
        ctx.lineTo(hx + 0.5, padT + ph);
        ctx.stroke();
        ctx.fillStyle = "#0a0e1a";
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(hx, hy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        const text = `₹${fmtINR(hp.value)}   ${label(hp.time)}`;
        const tw = ctx.measureText(text).width + 18;
        const bx = Math.min(Math.max(hx - tw / 2, padL), w - padR - tw);
        ctx.fillStyle = "#eef1fb";
        ctx.fillRect(bx, padT - 4, tw, 22);
        ctx.fillStyle = "#0a0e1a";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(text, bx + 9, padT + 7);
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;

    const onMove = (e: MouseEvent) => {
      hoverX = e.clientX - canvas.getBoundingClientRect().left;
      schedule();
    };
    const onLeave = () => {
      hoverX = null;
      schedule();
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    const ro = new ResizeObserver(schedule);
    ro.observe(wrap);

    const unsubscribe =
      mode === "live"
        ? subscribeChart(symbolKey, () => {
            setHasData((prev) => (prev ? prev : true));
            schedule();
          })
        : () => undefined;

    setHasData(points().length > 1 || (mode === "live" && points().length > 0));
    schedule();
    return () => {
      unsubscribe();
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [symbolKey, mode, hist, up]);

  useEffect(() => {
    scheduleRef.current();
  }, [stop]);

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="chart-el" />
      {!hasData && (
        <div className="chart-empty">
          {mode === "live" ? "Waiting for live ticks…" : "Price history is not loaded for this stock yet."}
        </div>
      )}
    </div>
  );
});

/* ------------------------------ UI helpers -------------------------------- */

interface Row {
  stock: Stock;
  quote: Quote | undefined;
  price: number;
  pct: number;
  signal: Signal | null;
}

const istClock = (ts: number): string =>
  new Date(ts * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

const ago = (nowMs: number, epochSec: number): string => {
  if (!epochSec) return "no data yet";
  const s = Math.max(0, Math.round(nowMs / 1000 - epochSec));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** Tile glow: stronger tint for bigger moves, saturating at +/-3%. */
function heatStyle(pct: number, live: boolean): React.CSSProperties {
  if (!live) return {};
  const k = Math.min(Math.abs(pct) / 3, 1);
  const rgb = pct >= 0 ? "0,245,160" : "255,77,125";
  return {
    background: `linear-gradient(155deg, rgba(${rgb},${(0.07 + k * 0.3).toFixed(3)}), rgba(${rgb},${(0.02 + k * 0.08).toFixed(3)}) 70%)`,
    borderColor: `rgba(${rgb},${(0.18 + k * 0.4).toFixed(3)})`,
  };
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1L3.2 9.6l6.1-.8L12 3.2z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const verdictColor = (v: Verdict): string =>
  v === "STRONG BUY" ? "#00f5a0" : v === "ACCUMULATE" ? "#00e5ff" : v === "HOLD" ? "#ffe14d" : "#ff4d7d";

function ScoreRing({ score, verdict, size = 34 }: { score: number; verdict: Verdict; size?: number }) {
  const style = {
    width: size,
    height: size,
    background: `conic-gradient(${verdictColor(verdict)} ${score * 3.6}deg, rgba(255,255,255,0.09) 0)`,
  } as React.CSSProperties;
  return (
    <span className="ring" style={style} title={`Quant score ${score} out of 99`}>
      <span className="ring-in" style={{ fontSize: size * 0.34 }}>
        {score}
      </span>
    </span>
  );
}

function VerdictChip({ verdict, full, prelim }: { verdict: Verdict; full?: boolean; prelim?: boolean }) {
  return (
    <span
      className={`vchip ${verdictClass(verdict)} ${prelim ? "vchip-prelim" : ""}`}
      title={prelim ? "Preliminary: based on today's price action only" : undefined}
    >
      {full ? verdict : verdictShort(verdict)}
      {prelim ? "*" : ""}
    </span>
  );
}

const avatarHue = (sym: string): number => {
  let h = 7;
  for (const c of sym) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

function Avatar({ symbol }: { symbol: string }) {
  const hue = avatarHue(symbol);
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ background: `linear-gradient(135deg,hsl(${hue} 78% 62%),hsl(${(hue + 55) % 360} 78% 48%))` }}
    >
      {tickerOf(symbol).slice(0, 2)}
    </span>
  );
}

/* --------------------------------- Tile ---------------------------------- */

interface TileProps {
  row: Row;
  starred: boolean;
  held: boolean;
  heldQty: number;
  heldPnlPct: number | null;
  riskBudget: number;
  evidence: Evidence;
  marketOpen: boolean;
  nowMin: number;
  active: boolean;
  onOpen: (symbol: string) => void;
  onStar: (symbol: string) => void;
  onTrade: (symbol: string, dir: 1 | -1) => void;
}

const istTime = (ts: number): string =>
  new Date(ts * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const Tile = memo(function Tile({ row, starred, held, heldQty, heldPnlPct, riskBudget, evidence, marketOpen, nowMin, active, onOpen, onStar, onTrade }: TileProps) {
  const { stock, quote, signal } = row;
  const live = Boolean(quote);
  const price = row.price;
  const pct = row.pct;
  const up = pct >= 0;
  const rangePos = quote && quote.high > quote.low ? clamp((price - quote.low) / (quote.high - quote.low), 0, 1) : null;

  const prev = useRef(price);
  const [pulse, setPulse] = useState(0);
  const [dir, setDir] = useState<"up" | "down">("up");
  useEffect(() => {
    if (price === prev.current) return;
    const first = prev.current === 0;
    setDir(price > prev.current ? "up" : "down");
    prev.current = price;
    if (!first) setPulse((n) => n + 1);
  }, [price]);

  return (
    <div
      className={`tile-card ${live ? (up ? "tile-up" : "tile-down") : "tile-loading"} ${active ? "tile-active" : ""}`}
      style={heatStyle(pct, live)}
      role="button"
      tabIndex={0}
      aria-label={`${stock.name}${live ? `, ${fmtINR(price)} rupees, ${fmtPct(pct)}` : ", waiting for price"}`}
      onClick={() => onOpen(stock.symbol)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(stock.symbol);
        }
      }}
    >
      <span className="tile-rail" aria-hidden="true" />
      {pulse > 0 && <span key={pulse} className={`tile-ping ping-${dir}`} aria-hidden="true" />}
      <div className="tile-head">
        <Avatar symbol={stock.symbol} />
        <div className="tile-id">
          <span className="tile-sym">{tickerOf(stock.symbol)}</span>
          <span className="tile-name">{stock.name}</span>
        </div>
        <span className="tile-badges">
          {held && <span className="dot-held" title="In your portfolio" />}
          <button
            className={`star ${starred ? "star-on" : ""}`}
            aria-label={starred ? `Remove ${stock.name} from watchlist` : `Add ${stock.name} to watchlist`}
            aria-pressed={starred}
            onClick={(e) => {
              e.stopPropagation();
              onStar(stock.symbol);
            }}
          >
            <StarIcon filled={starred} />
          </button>
        </span>
      </div>

      <div className="tile-meta">
        <span className="tag">{groupOf(stock)}</span>
        <span
          className={`tile-time ${quote && marketOpen && nowMin * 60 - quote.ts > 900 ? "tile-time-stale" : ""}`}
          title={quote && marketOpen && nowMin * 60 - quote.ts > 900 ? "No trade for over 15 minutes. This price may be old." : "Time of the last trade or quote update (IST)"}
        >
          {quote ? `Last trade ${istTime(quote.ts)}` : "Waiting for quote"}
        </span>
      </div>

      <div className="tile-mid">
        <span className="tile-price">{live ? `₹${fmtINR(price)}` : <span className="shimmer" />}</span>
        {live && (
          <span className={`pill ${up ? "pill-up" : "pill-down"}`}>
            {up ? "▲" : "▼"} {fmtPct(pct)}
          </span>
        )}
      </div>

      <div className="tile-range" title={quote ? `Today's range ₹${fmtINR(quote.low)} to ₹${fmtINR(quote.high)}` : undefined}>
        <span className="tile-range-track">
          {rangePos !== null && <span className="tile-range-dot" style={{ left: `${rangePos * 100}%` }} />}
        </span>
      </div>

      <div className="tile-bottom">
        {signal ? (
          <>
            <VerdictChip verdict={signal.verdict} prelim={signal.partial} />
            <span className="tile-metrics">
              <span title="Quant score out of 99">Q {signal.score}/99</span>
              <span title="RSI (14 day)">RSI {signal.rsi !== null ? signal.rsi.toFixed(1) : "—"}</span>
            </span>
            <ScoreRing score={signal.score} verdict={signal.verdict} size={30} />
          </>
        ) : (
          <span className="vchip v-none">{live ? "Analysing" : ""}</span>
        )}
      </div>

      {signal && (
        <>
          <div className="catalyst-box">
            <span className="catalyst-text">{signal.catalysts[0] ?? "No standout catalyst in the current price action"}</span>
            <span
              className={`conv ${evidence === "edge" ? "conv-high" : evidence === "negative" ? "conv-bad" : ""}`}
              title="Whether the track record panel found that this kind of signal beat the market in past data"
            >
              {EVIDENCE_LABEL[evidence]}
            </span>
          </div>
          <div className="tgt-grid">
            <span className="tgt">
              <span className="tgt-l">Target</span>
              <span className="txt-up">₹{fmtINR(signal.target)}</span>
            </span>
            <span className="tgt">
              <span className="tgt-l">Projected</span>
              <span className="txt-up">₹{fmtINR(signal.target)}</span>
            </span>
            <span className="tgt">
              <span className="tgt-l">Stop-loss</span>
              <span className="txt-down">₹{fmtINR(signal.stop)}</span>
            </span>
            {isBuy(signal.verdict) && (
              <span className="tgt">
                <span className="tgt-l">Safe qty</span>
                <span title="Includes costs, slippage allowance and a liquidity cap">{sizePosition(riskBudget, price, signal.stop, signal.atr, quote?.volume ?? 0).qty.toLocaleString("en-IN")}</span>
              </span>
            )}
          </div>
        </>
      )}

      {live && (
        <div className="hold-row" onClick={(e) => e.stopPropagation()}>
          <span className="hold-info">
            Held <b>{heldQty}</b>
            {heldPnlPct !== null && <span className={heldPnlPct >= 0 ? "txt-up" : "txt-down"}> {fmtPct(heldPnlPct)}</span>}
          </span>
          <span className="hold-btns">
            <span className="paper-tag" title="Paper trading: no order is sent to any broker">paper</span>
            <button className="tbtn tbtn-buy" onClick={() => onTrade(stock.symbol, 1)} aria-label={`Buy 1 share of ${stock.name}`}>
              +1 Buy
            </button>
            <button className="tbtn tbtn-sell" disabled={heldQty < 1} onClick={() => onTrade(stock.symbol, -1)} aria-label={`Sell 1 share of ${stock.name}`}>
              −1 Sell
            </button>
          </span>
        </div>
      )}
    </div>
  );
});

/* -------------------------------- List row -------------------------------- */

const ListRow = memo(function ListRow({ row, starred, held, active, onOpen, onStar }: TileProps) {
  const { stock, quote, signal } = row;
  const live = Boolean(quote);
  const up = row.pct >= 0;
  return (
    <div
      className={`lrow ${active ? "lrow-active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(stock.symbol)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(stock.symbol);
        }
      }}
    >
      <button
        className={`star ${starred ? "star-on" : ""}`}
        aria-label={starred ? `Remove ${stock.name} from watchlist` : `Add ${stock.name} to watchlist`}
        aria-pressed={starred}
        onClick={(e) => {
          e.stopPropagation();
          onStar(stock.symbol);
        }}
      >
        <StarIcon filled={starred} />
      </button>
      <div className="lrow-id">
        <span className="lrow-sym">
          {tickerOf(stock.symbol)} {held && <span className="dot-held" title="In your portfolio" />}
        </span>
        <span className="lrow-name">{stock.name}</span>
      </div>
      <span className="lrow-sector">{stock.sector}</span>
      <span className="lrow-verdict">{signal ? <VerdictChip verdict={signal.verdict} prelim={signal.partial} /> : null}</span>
      <span className="lrow-score">{signal ? <ScoreRing score={signal.score} verdict={signal.verdict} size={28} /> : null}</span>
      <span className="lrow-rsi">{signal?.rsi != null ? `RSI ${signal.rsi.toFixed(0)}` : ""}</span>
      <span className="lrow-price">{live ? `₹${fmtINR(row.price)}` : <span className="shimmer" />}</span>
      <span className={`lrow-pct ${live ? (up ? "txt-up" : "txt-down") : ""}`}>{live ? fmtPct(row.pct) : ""}</span>
    </div>
  );
});

/* ------------------------------- Side panels ------------------------------ */

function MoverList({
  title,
  rows,
  empty,
  onPick,
}: {
  title: string;
  rows: Row[];
  empty: string;
  onPick: (symbol: string) => void;
}) {
  return (
    <section className="panel">
      <h2 className="panel-title">{title}</h2>
      {rows.length === 0 && <div className="muted small">{empty}</div>}
      <ul className="movers">
        {rows.map((r) => (
          <li key={r.stock.symbol}>
            <button className="mover" onClick={() => onPick(r.stock.symbol)}>
              <span className="mover-id">
                <span className="mover-sym">{tickerOf(r.stock.symbol)}</span>
                <span className="mover-name">{r.stock.name}</span>
              </span>
              <span className="mover-right">
                <span className="mover-price">{r.quote ? `₹${fmtINR(r.price)}` : "—"}</span>
                {r.quote && <span className={r.pct >= 0 ? "txt-up" : "txt-down"}>{fmtPct(r.pct)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SectorBars({ items, onPick }: { items: { name: string; avg: number | null; count: number }[]; onPick: (name: string) => void }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.avg ?? 0)));
  return (
    <section className="panel">
      <h2 className="panel-title">Sector performance</h2>
      <ul className="sbars">
        {items.map((i) => (
          <li key={i.name}>
            <button className="sbar" onClick={() => onPick(i.name)}>
              <span className="sbar-name">{i.name}</span>
              <span className="sbar-track">
                <span className="sbar-mid" />
                {i.avg !== null && (
                  <span
                    className={`sbar-fill ${i.avg >= 0 ? "sbar-up" : "sbar-down"}`}
                    style={i.avg >= 0 ? { left: "50%", width: `${(i.avg / max) * 50}%` } : { right: "50%", width: `${(-i.avg / max) * 50}%` }}
                  />
                )}
              </span>
              <span className={`sbar-val ${i.avg === null ? "" : i.avg >= 0 ? "txt-up" : "txt-down"}`}>
                {i.avg === null ? "—" : fmtPct(i.avg)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const fmtCrore = (n: number): string => (n >= 1e7 ? `₹${(n / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr` : `₹${(n / 1e5).toFixed(1)} L`);

function ActiveList({ rows, onPick }: { rows: Row[]; onPick: (symbol: string) => void }) {
  return (
    <section className="panel">
      <h2 className="panel-title">Most traded today</h2>
      {rows.length === 0 && <div className="muted small">Waiting for volume data.</div>}
      <ul className="movers">
        {rows.map((r) => (
          <li key={r.stock.symbol}>
            <button className="mover" onClick={() => onPick(r.stock.symbol)}>
              <span className="mover-id">
                <span className="mover-sym">{tickerOf(r.stock.symbol)}</span>
                <span className="mover-name">{r.stock.name}</span>
              </span>
              <span className="mover-right">
                <span className="mover-price">{fmtCrore(r.price * (r.quote?.volume ?? 0))}</span>
                <span className={r.pct >= 0 ? "txt-up" : "txt-down"}>{fmtPct(r.pct)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------- Ribbon --------------------------------- */

function FeedPill({ status, feed, now }: { status: ConnStatus; feed: FeedState; now: number }) {
  let tone: "ok" | "warn" | "bad" = "ok";
  let text = feed.label;
  if (status !== "live") {
    tone = status === "connecting" ? "warn" : "bad";
    text = status === "connecting" ? "Connecting to backend" : "Backend offline";
  } else if (feed.source === "none") {
    tone = "bad";
    text = "No data source";
  } else if (!feed.marketOpen) {
    tone = "warn";
    text = "Market closed, showing last close";
  } else if (feed.delayed) {
    tone = "warn";
  }
  return (
    <div className={`feed feed-${tone}`} title={feed.detail || text}>
      <span className="feed-dot" />
      <span className="feed-text">{text}</span>
      {status === "live" && feed.updatedAt > 0 && <span className="feed-age">updated {ago(now, feed.updatedAt)}</span>}
    </div>
  );
}

function MarketRibbon({
  quotes,
  status,
  feed,
  now,
}: {
  quotes: Record<string, Quote>;
  status: ConnStatus;
  feed: FeedState;
  now: number;
}) {
  return (
    <div className="ribbon">
      <div className="ribbon-inner">
        <div className="ribbon-scroll">
          {INDICES.map(({ key, label }) => {
            const q = quotes[key];
            const up = (q?.changePct ?? 0) >= 0;
            return (
              <div className="ribbon-item" key={key}>
                <span className="ribbon-label">{label}</span>
                {q ? (
                  <>
                    <span className="ribbon-value">{fmtINR(q.ltp)}</span>
                    <span className={up ? "txt-up" : "txt-down"}>
                      {up ? "▲" : "▼"} {fmtPct(q.changePct)}
                    </span>
                  </>
                ) : (
                  <span className="shimmer shimmer-sm" />
                )}
              </div>
            );
          })}
        </div>
        <FeedPill status={status} feed={feed} now={now} />
      </div>
    </div>
  );
}

/* ------------------------------ Market pulse ------------------------------ */

function Pulse({
  advances,
  declines,
  unchanged,
  avg,
  total,
  growth,
  sells,
  scored,
}: {
  advances: number;
  declines: number;
  unchanged: number;
  avg: number | null;
  total: number;
  growth: number;
  sells: number;
  scored: number;
}) {
  const live = advances + declines + unchanged;
  const sum = Math.max(1, live);
  const mood =
    live === 0
      ? "Waiting for prices"
      : advances / sum >= 0.65
        ? "Broad rally"
        : advances / sum >= 0.52
          ? "Leaning positive"
          : advances / sum >= 0.4
            ? "Mixed session"
            : advances / sum >= 0.25
              ? "Leaning negative"
              : "Broad sell-off";
  return (
    <section className="pulse" aria-label="Market breadth">
      <div className="pulse-main">
        <div>
          <div className="pulse-kicker">Market mood</div>
          <div className="pulse-mood">{mood}</div>
          <div className="muted small">
            {live} of {total} stocks reporting
          </div>
        </div>
        <div className="pulse-avg">
          <span className="muted small">Average move</span>
          <span className={`pulse-avg-val ${avg === null ? "" : avg >= 0 ? "txt-up" : "txt-down"}`}>
            {avg === null ? "—" : fmtPct(avg)}
          </span>
        </div>
      </div>
      <div className="breadth-bar">
        <div className="breadth-adv" style={{ width: `${(advances / sum) * 100}%` }} />
        <div className="breadth-unch" style={{ width: `${(unchanged / sum) * 100}%` }} />
        <div className="breadth-dec" style={{ width: `${(declines / sum) * 100}%` }} />
      </div>
      <div className="pulse-stats">
        <span className="txt-up">
          <b>{advances}</b> advancing
        </span>
        <span className="txt-down">
          <b>{declines}</b> declining
        </span>
        <span className="pulse-sep" />
        <span className="txt-cyan">
          <b>{growth}</b> growth picks
        </span>
        <span className="txt-down">
          <b>{sells}</b> sell alerts
        </span>
        <span className="muted">{scored} scored</span>
      </div>
    </section>
  );
}

/* ----------------------------- Sell-alert banner -------------------------- */

function AlertBanner({
  flagged,
  held,
  onShow,
  onOpen,
}: {
  flagged: Row[];
  held: Row[];
  onShow: () => void;
  onOpen: (symbol: string) => void;
}) {
  if (flagged.length === 0) return null;
  const lead = held.length > 0 ? held : flagged.slice(0, 3);
  return (
    <div className={`alert ${held.length > 0 ? "alert-held" : ""}`} role="alert">
      <span className="alert-icon" aria-hidden="true">
        ⚠️
      </span>
      <div className="alert-text">
        <b>{held.length > 0 ? "Lock in gains: " : "Pre-reversal alert: "}</b>
        {held.length > 0
          ? `${held.length} of your holdings show a sell or book-profit signal.`
          : `${flagged.length} stocks show a sell or book-profit signal.`}{" "}
        {lead.map((r, i) => (
          <span key={r.stock.symbol}>
            <button className="alert-link" onClick={() => onOpen(r.stock.symbol)}>
              {tickerOf(r.stock.symbol)}
            </button>
            {i < lead.length - 1 ? ", " : ""}
          </span>
        ))}
      </div>
      <button className="alert-btn" onClick={onShow}>
        Show all {flagged.length}
      </button>
    </div>
  );
}

/* --------------------------------- Drawer --------------------------------- */

interface DrawerProps {
  stock: Stock;
  quote: Quote | undefined;
  ana: Analytics | undefined;
  signal: Signal | null;
  row: PortfolioRow | undefined;
  starred: boolean;
  feed: FeedState;
  index: number;
  count: number;
  riskBudget: number;
  setRiskBudget: (n: number) => void;
  onClose: () => void;
  onStep: (delta: number) => void;
  onStar: (symbol: string) => void;
  onPortfolio: () => void;
}

function RsiGauge({ rsi }: { rsi: number }) {
  return (
    <div className="gauge">
      <div className="gauge-track">
        <span className="gauge-zone gauge-low" />
        <span className="gauge-zone gauge-high" />
        <span className="gauge-dot" style={{ left: `${clamp(rsi, 0, 100)}%` }} />
      </div>
      <div className="gauge-scale">
        <span>Oversold 30</span>
        <span>Overbought 70</span>
      </div>
    </div>
  );
}

function Drawer({
  stock,
  quote,
  ana,
  signal,
  row,
  starred,
  feed,
  index,
  count,
  riskBudget,
  setRiskBudget,
  onClose,
  onStep,
  onStar,
  onPortfolio,
}: DrawerProps) {
  const live = Boolean(quote);
  const up = (quote?.changePct ?? 0) >= 0;
  const hist = ana?.hist ?? [];
  type Range = "1d" | "1w" | "1m";
  const [picked, setSpan] = useState<Range | null>(null);
  const span: Range = picked ?? (hist.length >= 2 ? "1m" : "1d");
  const rangeDays = span === "1w" ? 5 : 22;
  const shownHist = useMemo(() => (span === "1d" ? hist : hist.slice(-rangeDays)), [hist, span, rangeDays]);
  const effective: ChartMode = span === "1d" || hist.length < 2 ? "live" : "hist";
  const stopLevel = row ? row.stopPrice : signal?.stop ?? null;

  const range = quote && quote.high > quote.low ? (quote.ltp - quote.low) / (quote.high - quote.low) : 0.5;
  const prevMark =
    quote && quote.high > quote.low ? Math.min(1, Math.max(0, (quote.prevClose - quote.low) / (quote.high - quote.low))) : null;

  const sizing = signal && quote ? sizePosition(riskBudget, quote.ltp, signal.stop, signal.atr, quote.volume) : null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`${stock.name} details`}>
        <div className="drawer-bar">
          <div className="drawer-nav">
            <button className="icon-btn" onClick={() => onStep(-1)} aria-label="Previous stock">
              ←
            </button>
            <span className="muted small">
              {index + 1} of {count}
            </span>
            <button className="icon-btn" onClick={() => onStep(1)} aria-label="Next stock">
              →
            </button>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          <div className="drawer-title">
            <div>
              <h2 className="drawer-sym">{tickerOf(stock.symbol)}</h2>
              <div className="muted">
                {stock.name} <span className="tag">{groupOf(stock)}</span>
              </div>
            </div>
            <button className={`btn btn-ghost ${starred ? "btn-on" : ""}`} onClick={() => onStar(stock.symbol)} aria-pressed={starred}>
              <StarIcon filled={starred} />
              {starred ? "Watching" : "Watch"}
            </button>
          </div>

          <div className="drawer-price-row">
            <span className="drawer-price">{live ? `₹${fmtINR(quote!.ltp)}` : <span className="shimmer shimmer-lg" />}</span>
            {live && (
              <span className={`chg ${up ? "txt-up" : "txt-down"}`}>
                {up ? "▲ +" : "▼ −"}₹{fmtINR(Math.abs(quote!.change))} ({fmtPct(quote!.changePct)})
              </span>
            )}
          </div>
          <div className="muted small drawer-asof">
            {live
              ? `Price as of ${istClock(quote!.ts)} IST${feed.delayed ? " (delayed feed)" : ""}`
              : "Waiting for the first price from the backend."}
          </div>

          {signal ? (
            <section className="quant">
              <div className="quant-head">
                <ScoreRing score={signal.score} verdict={signal.verdict} size={64} />
                <div className="quant-head-text">
                  <VerdictChip verdict={signal.verdict} full prelim={signal.partial} />
                  <div className="muted small">Quant score {signal.score} out of 99</div>
                </div>
                {signal.rsi !== null && (
                  <div className="quant-rsi">
                    <span className="muted small">RSI (14 day)</span>
                    <span className="quant-rsi-val">{signal.rsi.toFixed(1)}</span>
                  </div>
                )}
              </div>
              {signal.partial && (
                <p className="prelim-note">
                  * Preliminary. This reading uses only today's price action. RSI, moving averages and the full score appear once
                  the backend loads daily price history.
                </p>
              )}
              {signal.rsi !== null && <RsiGauge rsi={signal.rsi} />}
              {signal.catalysts.length > 0 && (
                <ul className="catalysts">
                  {signal.catalysts.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <section className="quant quant-empty muted small">
              {live
                ? "The quant score appears once the backend has loaded this stock's daily price history."
                : "Waiting for data."}
            </section>
          )}

          <div className="seg seg-small" role="group" aria-label="Chart range">
            <button className={effective === "live" ? "seg-on" : ""} onClick={() => setSpan("1d")} title="Live ticks since this page opened">
              1D
            </button>
            <button className={effective === "hist" && span === "1w" ? "seg-on" : ""} onClick={() => setSpan("1w")} disabled={hist.length < 2}>
              1W
            </button>
            <button className={effective === "hist" && span === "1m" ? "seg-on" : ""} onClick={() => setSpan("1m")} disabled={hist.length < 2}>
              1M
            </button>
          </div>
          <PriceChart symbolKey={stock.symbol} mode={effective} hist={shownHist} up={up} stop={stopLevel} />
          <p className="muted small chart-note">
            {stopLevel !== null
              ? row
                ? `Red dashed line: your 3.5% trailing stop at ₹${fmtINR(stopLevel)}.`
                : `Red dashed line: suggested stop at ₹${fmtINR(stopLevel)}, ${signal?.stopBasis}.`
              : "A stop-loss line appears once price history is loaded."}
            {effective === "live" && live && !feed.marketOpen ? " The market is closed, so the live chart fills in after 9:15 IST." : ""}
          </p>

          {live && (
            <>
              <div className="range">
                <div className="range-head">
                  <span>Day's low ₹{fmtINR(quote!.low)}</span>
                  <span>Day's high ₹{fmtINR(quote!.high)}</span>
                </div>
                <div className="range-track">
                  {prevMark !== null && <span className="range-prev" style={{ left: `${prevMark * 100}%` }} title="Previous close" />}
                  <span className={`range-now ${up ? "range-up" : "range-down"}`} style={{ left: `${range * 100}%` }} />
                </div>
              </div>
              <div className="stats">
                <Stat label="Open" value={fmtINR(quote!.open)} />
                <Stat label="Previous close" value={fmtINR(quote!.prevClose)} />
                <Stat label="Volume" value={fmtCompact(quote!.volume)} />
                {ana?.hi52 != null && <Stat label="52-week high" value={fmtINR(ana.hi52)} />}
                {ana?.lo52 != null && <Stat label="52-week low" value={fmtINR(ana.lo52)} />}
                {ana?.beta != null && <Stat label="Beta vs Nifty 50" value={ana.beta.toFixed(2)} />}
                {ana?.sma50 != null && <Stat label="50-day average" value={fmtINR(ana.sma50)} />}
                {ana?.atr != null && <Stat label="Daily range (ATR)" value={fmtINR(ana.atr)} />}
                {ana?.vol != null && <Stat label="Volatility (yearly)" value={`${ana.vol.toFixed(1)}%`} />}
                {ana?.ret6 != null && <Stat label="6-month change" value={fmtPct(ana.ret6)} tone={ana.ret6 >= 0 ? "up" : "down"} />}
                {ana?.macdHist != null && (
                  <Stat label="MACD momentum" value={ana.macdHist >= 0 ? "Rising" : "Falling"} tone={ana.macdHist >= 0 ? "up" : "down"} />
                )}
                {ana?.pctB != null && (
                  <Stat label="Bollinger %B" value={`${ana.pctB.toFixed(2)}${ana.pctB > 1 ? " (stretched up)" : ana.pctB < 0 ? " (stretched down)" : ""}`} />
                )}
                {ana?.chandelier != null && <Stat label="Chandelier exit" value={`₹${fmtINR(ana.chandelier)}`} />}
              </div>
            </>
          )}

          {signal && isBuy(signal.verdict) && quote && sizing && (
            <section className="sizing">
              <div className="holding-title">Position sizing</div>
              <div className="sizing-row">
                <label className="sizing-input">
                  <span className="muted small">Risk budget (₹)</span>
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={riskBudget}
                    onChange={(e) => setRiskBudget(Math.max(0, Number(e.target.value)))}
                  />
                </label>
                <div className="sizing-result">
                  <span className="muted small">Safe purchase quantity</span>
                  <span className="sizing-qty">{sizing.qty.toLocaleString("en-IN")} shares</span>
                </div>
              </div>
              <ul className="sizing-break">
                <li>
                  <span>Price to stop</span>
                  <b>₹{fmtINR(sizing.stopGap)}</b>
                </li>
                <li>
                  <span>Costs ({COST_PCT}% round trip)</span>
                  <b>₹{fmtINR(sizing.costPer)}</b>
                </li>
                <li>
                  <span>Slippage and gap allowance</span>
                  <b>₹{fmtINR(sizing.bufferPer)}</b>
                </li>
                <li>
                  <span>Worst case per share</span>
                  <b>₹{fmtINR(sizing.perShare)}</b>
                </li>
              </ul>
              <p className="muted small chart-note">
                Capital needed: ₹{fmtINR(sizing.qty * quote.ltp)}. Estimated worst case: ₹{fmtINR(sizing.maxLoss)}. A stop is not a
                guarantee: if the stock gaps down overnight or trades thinly, you can lose more than this.
              </p>
              {sizing.warnings.map((w) => (
                <p key={w} className="prelim-note">
                  {w}
                </p>
              ))}
            </section>
          )}

          <NewsList symbol={stock.symbol} name={stock.name} />

          {row ? (
            <div className="holding">
              <div className="holding-title">Your position</div>
              <div className="stats">
                <Stat label="Quantity" value={String(row.holding.qty)} />
                <Stat label="Average price" value={`₹${fmtINR(row.holding.avgPrice)}`} />
                <Stat
                  label="Profit or loss"
                  value={`${row.pnl >= 0 ? "+" : "−"}₹${fmtINR(Math.abs(row.pnl))} (${fmtPct(row.pnlPct)})`}
                  tone={row.pnl >= 0 ? "up" : "down"}
                />
                <Stat label="Trailing stop (3.5%)" value={`₹${fmtINR(row.stopPrice)}`} tone={row.stopHit ? "down" : undefined} />
              </div>
              {row.stopHit && <div className="stop-hit">Stop triggered</div>}
            </div>
          ) : (
            <button className="btn btn-primary btn-wide" onClick={onPortfolio}>
              Add to portfolio
            </button>
          )}
          <p className="fineprint">
            The quant score is a rule-based reading of trend, RSI, 30-day momentum and the 52-week range. It describes what price
            has done, not what it will do, and it is not investment advice.
          </p>
        </div>
      </aside>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone === "up" ? "txt-up" : tone === "down" ? "txt-down" : ""}`}>{value}</span>
    </div>
  );
}

/* ----------------------------- Live Quant lookup --------------------------- */

function LookupDock({
  value,
  busy,
  message,
  onChange,
  onSubmit,
}: {
  value: string;
  busy: boolean;
  message: { tone: "ok" | "bad"; text: string } | null;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="dock">
      <form
        className="dock-inner"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="dock-copy">
          <span className="dock-title">Live Quant fetch</span>
          <span className="muted small">Pull a live quote for any NSE symbol outside the 172 tracked stocks</span>
        </div>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder="NSE symbol, for example ZENSARTECH"
          aria-label="NSE symbol to fetch"
          spellCheck={false}
          autoCapitalize="characters"
        />
        <button className="btn btn-accent" type="submit" disabled={busy || value.trim() === ""}>
          {busy ? "Fetching…" : "Fetch live quote"}
        </button>
        {message && (
          <span className={`dock-msg ${message.tone === "ok" ? "txt-up" : "txt-down"}`} role="status">
            {message.text}
          </span>
        )}
      </form>
    </div>
  );
}

/* ---------------------------- Portfolio risk manager ---------------------- */

interface PortfolioModalProps {
  summary: PortfolioSummary;
  history: HistoryPoint[];
  stocks: Stock[];
  quotes: Record<string, Quote>;
  analytics: Record<string, Analytics>;
  signals: Record<string, Signal | null>;
  journal: JournalEntry[];
  histStats: HistStats | null;
  onTrade: (symbol: string, side: "buy" | "sell", qty: number, price: number) => void;
  onExport: () => void;
  onImport: (text: string) => string;
  onClose: () => void;
  onOpen: (symbol: string) => void;
}

function PortfolioModal({
  summary,
  history,
  stocks,
  quotes,
  analytics,
  signals,
  journal,
  histStats,
  onTrade,
  onExport,
  onImport,
  onClose,
  onOpen,
}: PortfolioModalProps) {
  const [symbolInput, setSymbolInput] = useState("");
  const [qtyInput, setQtyInput] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sharpe = histStats?.sharpe ?? computeSharpeRatio(history);
  const mdd = histStats ? histStats.mdd : computeMaxDrawdown(history);
  const [importMsg, setImportMsg] = useState("");
  const [notify, setNotify] = useState<string>(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const beta = portfolioBeta(summary.rows, analytics);

  const addHolding = () => {
    const raw = symbolInput.trim().toUpperCase().replace(/\.NS$/, "");
    const stock = stocks.find((st) => tickerOf(st.symbol) === raw);
    const qty = Number(qtyInput);
    const avg = Number(priceInput);
    if (!stock) return setError("Pick a symbol from the list, or fetch it first with Live Quant fetch.");
    if (!(qty > 0) || !Number.isFinite(qty)) return setError("Quantity must be greater than zero.");
    if (!(avg > 0) || !Number.isFinite(avg)) return setError("Average price must be greater than zero.");
    setError("");
    onTrade(stock.symbol, "buy", qty, avg);
    setSymbolInput("");
    setQtyInput("");
    setPriceInput("");
  };


  const pnlTone = summary.pnl >= 0 ? "txt-up" : "txt-down";
  const dayTone = summary.dayPnl >= 0 ? "txt-up" : "txt-down";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Portfolio risk manager">
        <div className="modal-head">
          <div>
            <h2>
              Portfolio risk manager <span className="paper-tag">paper portfolio</span>
            </h2>
            <div className="muted small">Live profit and loss, trailing stops and risk diagnostics. No order is ever sent to a broker.</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tiles">
          <div className="mtile">
            <span className="mtile-label">Total invested</span>
            <span className="mtile-value">₹{fmtINR(summary.invested)}</span>
          </div>
          <div className="mtile">
            <span className="mtile-label">Current value</span>
            <span className="mtile-value">₹{fmtINR(summary.value)}</span>
          </div>
          <div className="mtile">
            <span className="mtile-label">Live profit and loss</span>
            <span className={`mtile-value ${pnlTone}`}>
              {summary.pnl >= 0 ? "+" : "−"}₹{fmtINR(Math.abs(summary.pnl))} ({fmtPct(summary.pnlPct)})
            </span>
          </div>
          <div className="mtile">
            <span className="mtile-label">Today</span>
            <span className={`mtile-value ${dayTone}`}>
              {summary.dayPnl >= 0 ? "+" : "−"}₹{fmtINR(Math.abs(summary.dayPnl))}
            </span>
          </div>
          <div className="mtile">
            <span className="mtile-label">Sharpe ratio (est.)</span>
            <span className="mtile-value">{sharpe === null ? "Needs 5+ days" : sharpe.toFixed(2)}</span>
            {histStats && <span className="mtile-sub">last {histStats.days} sessions, today's quantities</span>}
          </div>
          <div className="mtile">
            <span className="mtile-label">Maximum drawdown</span>
            <span className={`mtile-value ${mdd !== null && mdd < 0 ? "txt-down" : ""}`}>
              {mdd === null ? "Needs 2+ days" : `${mdd.toFixed(2)}%`}
            </span>
            {histStats && <span className="mtile-sub">same window{histStats.covered < histStats.total ? `, ${histStats.covered} of ${histStats.total} holdings` : ""}</span>}
          </div>
          <div className="mtile">
            <span className="mtile-label">Beta vs Nifty 50</span>
            <span className="mtile-value">{beta === null ? "—" : beta.toFixed(2)}</span>
          </div>
          {histStats && histStats.sortino !== null && (
            <div className="mtile">
              <span className="mtile-label">Sortino ratio</span>
              <span className="mtile-value">{histStats.sortino.toFixed(2)}</span>
              <span className="mtile-sub">penalises only the downside</span>
            </div>
          )}
          {histStats && histStats.vol !== null && (
            <div className="mtile">
              <span className="mtile-label">Volatility (yearly)</span>
              <span className="mtile-value">{histStats.vol.toFixed(1)}%</span>
            </div>
          )}
          {histStats && histStats.var95 !== null && histStats.cvar95 !== null && (
            <div className="mtile">
              <span className="mtile-label">1-day loss, bad day (95%)</span>
              <span className="mtile-value txt-down">₹{fmtINR(histStats.var95)}</span>
              <span className="mtile-sub">worst 5% of days average ₹{fmtINR(histStats.cvar95)}</span>
            </div>
          )}
          {histStats && histStats.calmar !== null && (
            <div className="mtile">
              <span className="mtile-label">Calmar ratio</span>
              <span className="mtile-value">{histStats.calmar.toFixed(2)}</span>
              <span className="mtile-sub">yearly return per unit of drawdown</span>
            </div>
          )}
        </div>

        <div className="add-row">
          <input
            list="symbol-list"
            placeholder="Symbol (e.g. RELIANCE)"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value)}
          />
          <datalist id="symbol-list">
            {stocks.map((st) => (
              <option key={st.symbol} value={tickerOf(st.symbol)}>
                {st.name}
              </option>
            ))}
          </datalist>
          <input type="number" min="0" placeholder="Quantity" value={qtyInput} onChange={(e) => setQtyInput(e.target.value)} />
          <input
            type="number"
            min="0"
            step="0.05"
            placeholder="Average price ₹"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
          />
          <button className="btn btn-accent" onClick={addHolding}>
            Add position
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}

        {summary.rows.length === 0 ? (
          <div className="empty">No positions yet. Add one above to see live profit and loss, trailing stops and exit guidance.</div>
        ) : (
          <div className="holds">
            {summary.rows.map((r) => {
              const sig = signals[r.holding.symbol] ?? null;
              const entry = evaluateEntry(r.holding.avgPrice, analytics[r.holding.symbol], quotes[r.holding.symbol]);
              const exit = exitAdvice(r, sig);
              return (
                <article key={r.holding.symbol} className={`hold ${r.stopHit ? "hold-stop" : ""}`}>
                  <header className="hold-head">
                    <button className="hold-id" onClick={() => onOpen(r.holding.symbol)}>
                      <span className="hold-sym">{tickerOf(r.holding.symbol)}</span>
                      <span className="muted small">{r.stock?.name}</span>
                    </button>
                    {sig && <VerdictChip verdict={sig.verdict} full />}
                    <span className={`hold-pnl ${r.pnl >= 0 ? "txt-up" : "txt-down"}`}>
                      {r.pnl >= 0 ? "+" : "−"}₹{fmtINR(Math.abs(r.pnl))}
                      <small>{fmtPct(r.pnlPct)}</small>
                    </span>
                    <button className="icon-btn" onClick={() => onTrade(r.holding.symbol, "sell", r.holding.qty, r.ltp)} aria-label={`Close ${r.holding.symbol} at the last price`} title="Close the position at the last price">
                      ✕
                    </button>
                  </header>
                  <div className="stats">
                    <Stat label="Quantity" value={String(r.holding.qty)} />
                    <Stat label="Average price" value={`₹${fmtINR(r.holding.avgPrice)}`} />
                    <Stat label="Last price" value={`₹${fmtINR(r.ltp)}`} />
                    <Stat label="Peak since entry" value={`₹${fmtINR(Math.max(r.holding.peak, r.ltp))}`} />
                    <Stat label="Trailing stop (3.5%)" value={`₹${fmtINR(r.stopPrice)}`} tone={r.stopHit ? "down" : undefined} />
                  </div>
                  <ul className="advice">
                    <li className={`adv-${entry.tone}`}>{entry.text}</li>
                    <li className="adv-ok">{protectionStatus(r)}</li>
                    <li className={`adv-${exit.tone}`}>{exit.text}</li>
                  </ul>
                </article>
              );
            })}
          </div>
        )}
        <JournalTable journal={journal} />

        <div className="backup-row">
          <button className="btn btn-ghost" onClick={onExport}>
            Export backup
          </button>
          <label className="btn btn-ghost">
            Import backup
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                file.text().then((t) => setImportMsg(onImport(t)), () => setImportMsg("Could not read that file."));
              }}
            />
          </label>
          {notify !== "unsupported" && notify !== "granted" && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                void Notification.requestPermission().then((p) => setNotify(p));
              }}
            >
              Enable stop alerts
            </button>
          )}
          {notify === "granted" && <span className="muted small">Stop alerts on (while this page is open)</span>}
          {importMsg && <span className="muted small">{importMsg}</span>}
        </div>

        <p className="fineprint">
          Sharpe and drawdown replay your current holdings over the last sessions of real closes (or, without history, use end-of-day
          snapshots stored in this browser; 6.5% risk-free rate, 252 days). Positions are stored only in this browser: export a backup
          now and then. Beta uses each stock's daily returns against the Nifty 50 over about six months. Positions never leave your device.
          These are rule-based readings, not investment advice.
        </p>
      </div>
    </div>
  );
}

/* ----------------------- Reliability and honesty tools ---------------------- */

const COST_NOTE = `${COST_PCT}% round-trip costs`;

async function apiGet<T>(path: string): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}${path}`, { headers: API_KEY ? { "X-API-Key": API_KEY } : {} });
  } catch {
    throw new Error("Could not reach the backend. Check that uvicorn is running.");
  }
  if (!resp.ok) {
    let detail = `The backend returned an error (${resp.status}).`;
    try {
      const body = (await resp.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* keep default */
    }
    throw new Error(detail);
  }
  return (await resp.json()) as T;
}

const timeAgo = (epochSec: number | null, nowMs: number): string => {
  if (!epochSec) return "";
  const s = Math.max(0, Math.round(nowMs / 1000 - epochSec));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/* ------------------------------ Position sizing ----------------------------- */

interface Sizing {
  qty: number;
  stopGap: number; // price minus stop, per share
  costPer: number; // estimated round-trip costs, per share
  bufferPer: number; // allowance for slippage and a gap through the stop, per share
  perShare: number; // all of the above
  maxLoss: number; // qty x perShare (what the budget is protecting)
  capped: boolean; // limited by liquidity
  warnings: string[];
}

/**
 * How many shares keep the estimated worst case inside the budget. Unlike price-minus-stop alone, it also
 * counts costs and a slippage allowance (half a day's average range), and it never suggests more than 1% of the
 * day's traded volume, so an illiquid stock cannot be sized into something you cannot exit.
 */
function sizePosition(budget: number, price: number, stop: number, atr: number | null, volume: number): Sizing {
  const stopGap = Math.max(0, price - stop);
  const costPer = (price * COST_PCT) / 100;
  const bufferPer = atr !== null && atr > 0 ? 0.5 * atr : price * 0.005;
  const perShare = stopGap + costPer + bufferPer;
  let qty = perShare > 0 && budget > 0 ? Math.floor(budget / perShare) : 0;
  const warnings: string[] = [];
  let capped = false;
  if (volume > 0) {
    const cap = Math.floor(volume * 0.01);
    if (qty > cap) {
      qty = cap;
      capped = true;
      warnings.push("Limited to 1% of today's traded volume: this stock may be hard to exit in size.");
    }
  }
  if (atr !== null && atr > 0 && stopGap < atr) {
    warnings.push("The stop is closer than one average daily range, so normal movement may trigger it.");
  }
  return { qty, stopGap, costPer, bufferPer, perShare, maxLoss: qty * perShare, capped, warnings };
}

/* ------------------------ Portfolio stats from real history ----------------- */

interface HistStats {
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  vol: number | null; // annualised %
  var95: number | null; // one-day 95% historical value at risk, rupees
  cvar95: number | null; // average loss on the worst 5% of days, rupees
  mdd: number | null;
  days: number;
  ret: number | null;
  covered: number;
  total: number;
}

/** Replays today's holdings over the last sessions of real closes the backend sent (not your own trade history). */
function portfolioFromHistory(holdings: Holding[], analytics: Record<string, Analytics>): HistStats | null {
  const usable = holdings.filter((h) => (analytics[h.symbol]?.hist.length ?? 0) >= 20);
  if (usable.length === 0) return null;
  const perDay = usable.map((h) => {
    const m = new Map<string, number>();
    for (const [t, close] of analytics[h.symbol].hist) m.set(new Date((t + IST_OFFSET) * 1000).toISOString().slice(0, 10), close * h.qty);
    return m;
  });
  const common = [...perDay[0].keys()].filter((d) => perDay.every((m) => m.has(d))).sort();
  if (common.length < 20) return null;
  const values = common.map((d) => perDay.reduce((sum, m) => sum + (m.get(d) as number), 0));
  const rets: number[] = [];
  for (let i = 1; i < values.length; i++) if (values[i - 1] > 0) rets.push(values[i] / values[i - 1] - 1);
  let sharpe: number | null = null;
  let sortino: number | null = null;
  let vol: number | null = null;
  let var95: number | null = null;
  let cvar95: number | null = null;
  const rf = Math.pow(1 + RISK_FREE_ANNUAL, 1 / 252) - 1;
  if (rets.length >= 10) {
    const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1));
    sharpe = sd > 0 ? ((mean - rf) / sd) * Math.sqrt(252) : null;
    vol = sd * Math.sqrt(252) * 100;
    // Sortino: like Sharpe, but only penalises returns below the risk-free rate (downside deviation).
    const dd = Math.sqrt(rets.reduce((a, r) => a + Math.min(0, r - rf) ** 2, 0) / rets.length);
    sortino = dd > 0 ? ((mean - rf) / dd) * Math.sqrt(252) : null;
  }
  if (rets.length >= 30) {
    // Historical simulation: the 5th percentile of real daily returns, applied to today's value.
    const sorted = [...rets].sort((a, b) => a - b);
    const k = Math.max(0, Math.floor(0.05 * sorted.length) - 1);
    const today = values[values.length - 1];
    var95 = Math.max(0, -sorted[k]) * today;
    const tail = sorted.slice(0, k + 1);
    cvar95 = Math.max(0, -(tail.reduce((a, r) => a + r, 0) / tail.length)) * today;
  }
  let nav = 1;
  let peak = 1;
  let worst = 0;
  for (const r of rets) {
    nav *= 1 + r;
    peak = Math.max(peak, nav);
    worst = Math.min(worst, (nav - peak) / peak);
  }
  const totalRet = values[values.length - 1] / values[0] - 1;
  const annRet = Math.pow(1 + totalRet, 252 / Math.max(1, rets.length)) - 1;
  const calmar = rets.length >= 40 && worst < -0.001 ? annRet / Math.abs(worst) : null;
  return {
    sharpe,
    sortino,
    calmar,
    vol,
    var95,
    cvar95,
    mdd: worst * 100,
    days: common.length,
    ret: (values[values.length - 1] / values[0] - 1) * 100,
    covered: usable.length,
    total: holdings.length,
  };
}

/* ------------------------------- Backtest ----------------------------------- */

interface BtBucket {
  n: number;
  mean: number | null;
  median: number | null;
  hit: number | null;
  excess: number | null;
  se: number | null;
  days: number;
  significant: boolean;
}

interface Backtest {
  generated_at: string;
  stocks: number;
  observations: number;
  horizons: number[];
  baseline: Record<string, { n: number; mean: number | null; hit: number | null }>;
  buckets: Record<string, Record<string, BtBucket>>;
  trades: { n: number; win_rate?: number; avg_net_return?: number; stopped_pct?: number; target_pct?: number; timed_out_pct?: number; cost_pct?: number };
  verdict_text: string;
  caveats: string[];
}

type Evidence = "pending" | "edge" | "none" | "negative";

const evidenceOf = (bt: Backtest | null): Evidence => {
  const b = bt?.buckets?.["ALL BUY"]?.["10"];
  if (!bt || !b || b.excess === null) return "pending";
  if (b.significant && b.excess > 0) return "edge";
  if (b.significant && b.excess < 0) return "negative";
  return "none";
};

const EVIDENCE_LABEL: Record<Evidence, string> = {
  pending: "Evidence pending",
  edge: "Backtested edge",
  none: "No proven edge",
  negative: "Backtest negative",
};

function useBacktest(): { data: Backtest | null; error: string } {
  const [data, setData] = useState<Backtest | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const bt = await apiGet<Backtest>("/api/v1/backtest");
        if (!alive) return;
        setData(bt);
        setError("");
        timer = setTimeout(load, 30 * 60 * 1000);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Backtest unavailable.");
        timer = setTimeout(load, 45 * 1000);
      }
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return { data, error };
}

function TrackRecordPanel({ data, error }: { data: Backtest | null; error: string }) {
  const rows = ["STRONG BUY", "ACCUMULATE", "HOLD", "SELL / BOOK PROFIT"];
  return (
    <section className="panel">
      <h2 className="panel-title">Signal track record</h2>
      {!data && <p className="muted small">{error || "Loading..."} The backtest needs the price history to finish loading first.</p>}
      {data && (
        <>
          <p className={`tr-verdict tr-${evidenceOf(data)}`}>{data.verdict_text}</p>
          <table className="tr-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th title="Average return 10 trading days later">10d avg</th>
                <th title="Return minus the average stock on the same day">vs market</th>
                <th title="Share of cases that were positive">Up %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const b = data.buckets[v]?.["10"];
                if (!b || b.n === 0) return null;
                return (
                  <tr key={v}>
                    <td>{v === "SELL / BOOK PROFIT" ? "SELL" : v}</td>
                    <td className={(b.mean ?? 0) >= 0 ? "txt-up" : "txt-down"}>{b.mean === null ? "n/a" : fmtPct(b.mean)}</td>
                    <td className={(b.excess ?? 0) >= 0 ? "txt-up" : "txt-down"}>
                      {b.excess === null ? "n/a" : fmtPct(b.excess)}
                      {b.significant ? " ✓" : ""}
                    </td>
                    <td>{b.hit === null ? "n/a" : `${b.hit.toFixed(0)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.trades.n > 0 && (
            <p className="muted small">
              Simulated buy trades (5% stop, 8% target, 20 days max, {COST_NOTE}): {data.trades.n.toLocaleString("en-IN")} trades, average{" "}
              {fmtPct(data.trades.avg_net_return ?? 0)}, {data.trades.win_rate?.toFixed(0)}% won, {data.trades.stopped_pct?.toFixed(0)}% hit the stop.
            </p>
          )}
          <p className="muted small">
            ✓ means the gap versus the market is more than 2 standard errors from zero. Tested on {data.stocks} stocks, {data.observations.toLocaleString("en-IN")} stock-days.{" "}
            {data.caveats.join(" ")}
          </p>
        </>
      )}
    </section>
  );
}

/* ------------------------------- Data health -------------------------------- */

function DataHealthPanel({
  feed,
  nowMs,
  status,
  priced,
  total,
  withHistory,
  missing,
  stale,
}: {
  feed: FeedState;
  nowMs: number;
  status: ConnStatus;
  priced: number;
  total: number;
  withHistory: number;
  missing: string[];
  stale: boolean;
}) {
  const age = feed.updatedAt > 0 ? Math.max(0, Math.round(nowMs / 1000 - feed.updatedAt)) : null;
  const tone = status !== "live" || feed.source === "none" ? "bad" : stale ? "warn" : "ok";
  return (
    <section className="panel">
      <h2 className="panel-title">Data health</h2>
      <ul className="health">
        <li>
          <span>Backend</span>
          <b className={`hl-${status === "live" ? "ok" : "bad"}`}>{status === "live" ? "Connected" : status === "connecting" ? "Connecting" : "Offline"}</b>
        </li>
        <li>
          <span>Price source</span>
          <b className={`hl-${tone}`}>{feed.label || "None"}</b>
        </li>
        <li>
          <span>Last update</span>
          <b className={`hl-${stale ? "warn" : "ok"}`}>{age === null ? "none yet" : age < 5 ? "just now" : `${age}s ago`}</b>
        </li>
        <li>
          <span>Stocks priced</span>
          <b>
            {priced} of {total}
          </b>
        </li>
        <li>
          <span>Price history loaded</span>
          <b className={withHistory < total * 0.8 ? "hl-warn" : "hl-ok"}>
            {withHistory} of {total}
          </b>
        </li>
        <li>
          <span>Market</span>
          <b>{feed.marketOpen ? "Open" : "Closed"}</b>
        </li>
      </ul>
      {missing.length > 0 && (
        <p className="muted small">
          No source priced: {missing.slice(0, 8).map((k) => tickerOf(k)).join(", ")}
          {missing.length > 8 ? ` and ${missing.length - 8} more` : ""}. They are hidden from the board; the ticker may have changed.
        </p>
      )}
      {feed.delayed && <p className="muted small">Prices come from a delayed source. Do not use them for timing.</p>}
    </section>
  );
}

/* --------------------------------- News ------------------------------------- */

interface NewsItem {
  title: string;
  source: string;
  url: string;
  ts: number | null;
}

function useNews(symbol: string, name: string): { items: NewsItem[]; loading: boolean; error: string } {
  const [state, setState] = useState<{ items: NewsItem[]; loading: boolean; error: string }>({ items: [], loading: true, error: "" });
  useEffect(() => {
    let alive = true;
    setState({ items: [], loading: true, error: "" });
    apiGet<{ items: NewsItem[]; error: string }>(`/api/v1/market/news/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name)}`)
      .then((r) => alive && setState({ items: r.items, loading: false, error: r.items.length === 0 ? r.error : "" }))
      .catch((e: unknown) => alive && setState({ items: [], loading: false, error: e instanceof Error ? e.message : "News unavailable." }));
    return () => {
      alive = false;
    };
  }, [symbol, name]);
  return state;
}

function NewsList({ symbol, name }: { symbol: string; name: string }) {
  const { items, loading, error } = useNews(symbol, name);
  return (
    <section className="news">
      <div className="holding-title">Latest headlines</div>
      {loading && <div className="muted small">Loading headlines...</div>}
      {!loading && items.length === 0 && (
        <div className="muted small">{error ? `Headlines unavailable: ${error}` : "No recent headlines found."}</div>
      )}
      <ul className="news-list">
        {items.map((n) => (
          <li key={n.url}>
            <a href={n.url} target="_blank" rel="noopener noreferrer">
              {n.title}
            </a>
            <span className="muted small">
              {n.source}
              {n.ts ? ` · ${timeAgo(n.ts, Date.now())}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted small">Headlines are shown as published by their sources. MarketMind does not judge whether they are good or bad news.</p>
    </section>
  );
}

/* -------------------------- Journal, backup and restore --------------------- */

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

interface BackupFile {
  app: "marketmind";
  version: 1;
  exportedAt: string;
  holdings: Holding[];
  history: HistoryPoint[];
  journal: JournalEntry[];
  watch: string[];
  custom: CustomStock[];
  riskBudget: number;
}

function downloadBackup(b: BackupFile): void {
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `marketmind-backup-${b.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Validates an imported file; returns the cleaned data or a plain-English reason it was refused. */
function parseBackup(text: string): { ok: true; data: BackupFile } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file is not valid JSON." };
  }
  const o = raw as Partial<BackupFile> | null;
  if (!o || typeof o !== "object" || o.app !== "marketmind" || o.version !== 1) return { ok: false, reason: "That is not a MarketMind backup file." };
  const sym = (s: unknown): s is string => typeof s === "string" && /^[A-Z0-9&-]{1,20}\.NS$/.test(s);
  const holdings = (Array.isArray(o.holdings) ? o.holdings : []).filter(
    (h): h is Holding => !!h && sym(h.symbol) && isNum(h.qty) && h.qty > 0 && isNum(h.avgPrice) && h.avgPrice > 0 && isNum(h.peak)
  );
  const history = (Array.isArray(o.history) ? o.history : []).filter(
    (p): p is HistoryPoint => !!p && typeof p.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.d) && isNum(p.v) && isNum(p.i)
  );
  const journal = (Array.isArray(o.journal) ? o.journal : []).filter(
    (j): j is JournalEntry =>
      !!j && isNum(j.t) && sym(j.symbol) && (j.side === "buy" || j.side === "sell") && isNum(j.qty) && j.qty > 0 && isNum(j.price) && j.price > 0
  );
  const watch = (Array.isArray(o.watch) ? o.watch : []).filter(sym);
  const custom = (Array.isArray(o.custom) ? o.custom : []).filter(
    (c): c is CustomStock => !!c && sym(c.symbol) && typeof c.name === "string"
  );
  const riskBudget = isNum(o.riskBudget) && o.riskBudget > 0 ? o.riskBudget : DEFAULT_RISK_BUDGET;
  return {
    ok: true,
    data: { app: "marketmind", version: 1, exportedAt: String(o.exportedAt ?? ""), holdings, history, journal: journal.slice(-500), watch, custom, riskBudget },
  };
}

function JournalTable({ journal }: { journal: JournalEntry[] }) {
  const realized = journal.reduce((a, j) => a + (j.realized ?? 0), 0);
  const recent = [...journal].reverse().slice(0, 12);
  return (
    <section className="journal">
      <div className="holding-title">
        Paper trade journal
        <span className={realized >= 0 ? "txt-up" : "txt-down"}>
          {" "}
          Realised {realized >= 0 ? "+" : "−"}₹{fmtINR(Math.abs(realized))} before costs
        </span>
      </div>
      {recent.length === 0 ? (
        <div className="muted small">No trades yet. Every +1 Buy, −1 Sell and position change is recorded here.</div>
      ) : (
        <table className="tr-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Trade</th>
              <th>Price</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((j) => (
              <tr key={j.t + j.symbol + j.side}>
                <td>{new Date(j.t).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}</td>
                <td>
                  {j.side === "buy" ? "Buy" : "Sell"} {j.qty} {tickerOf(j.symbol)}
                </td>
                <td>₹{fmtINR(j.price)}</td>
                <td className={j.realized === undefined ? "" : j.realized >= 0 ? "txt-up" : "txt-down"}>
                  {j.realized === undefined ? "" : `${j.realized >= 0 ? "+" : "−"}₹${fmtINR(Math.abs(j.realized))}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ---------------------------------- App ---------------------------------- */

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("MarketMind render error:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", color: "#eef1fb", background: "#0a0e1a", minHeight: "100vh" }}>
          <h2 style={{ color: "#ff4d7d" }}>MarketMind hit an error while drawing the page</h2>
          <pre style={{ whiteSpace: "pre-wrap", background: "#121a30", padding: 12, borderRadius: 8 }}>
            {String(this.state.error.stack ?? this.state.error.message)}
          </pre>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <MarketMindApp />
    </ErrorBoundary>
  );
}

interface Group {
  name: string | null;
  rows: Row[];
  avg: number | null;
}

const average = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function MarketMindApp() {
  const [custom, setCustom] = usePersistentState<CustomStock[]>(LS_CUSTOM, []);
  const customKeys = useMemo(() => custom.map((c) => c.symbol), [custom]);
  const { quotes, analytics, status, feed, ingestExternal, track } = useMarketSocket(customKeys);

  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const [filter, setFilter] = useState<SignalFilter>("all");
  const [sort, setSort] = useState<SortKey>("default");
  const [view, setView] = usePersistentState<ViewMode>(LS_VIEW, "board");
  const [openSymbol, setOpenSymbol] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [watch, setWatch] = usePersistentState<string[]>(LS_WATCH, STARTER_WATCH);
  const [holdings, setHoldings] = usePersistentState<Holding[]>(LS_HOLDINGS, []);
  const [history, setHistory] = usePersistentState<HistoryPoint[]>(LS_HISTORY, []);
  const [riskBudget, setRiskBudget] = usePersistentState<number>(LS_RISK, DEFAULT_RISK_BUDGET);
  const [journal, setJournal] = usePersistentState<JournalEntry[]>(LS_JOURNAL, []);
  const backtest = useBacktest();
  const evidence = evidenceOf(backtest.data);
  const [now, setNow] = useState(() => Date.now());
  const [lookupText, setLookupText] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupMsg, setLookupMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const lastSnapshot = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const universe: Stock[] = useMemo(
    () => [
      ...custom.map<Stock>((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: "Custom",
        latest_close: 0,
        pct_change: 0,
        trajectory_outlook: "Neutral",
        sentiment_score: 0,
        custom: true,
      })),
      ...ULTIMATE_INDIAN_MARKET_UNIVERSE,
    ],
    [custom]
  );

  const missingSet = useMemo(() => new Set(feed.missing), [feed.missing]);
  const watchSet = useMemo(() => new Set(watch), [watch]);
  const heldSet = useMemo(() => new Set(holdings.map((h) => h.symbol)), [holdings]);

  const toggleWatch = useCallback(
    (symbol: string) => setWatch((prev) => (prev.includes(symbol) ? prev.filter((x) => x !== symbol) : [...prev, symbol])),
    [setWatch]
  );

  const rows: Row[] = useMemo(
    () =>
      universe.map((stock) => {
        const quote = quotes[stock.symbol];
        return {
          stock,
          quote,
          price: quote?.ltp ?? 0,
          pct: quote?.changePct ?? 0,
          signal: computeSignal(quote, analytics[stock.symbol]),
        };
      }),
    [universe, quotes, analytics]
  );

  const signals = useMemo(() => {
    const m: Record<string, Signal | null> = {};
    for (const r of rows) m[r.stock.symbol] = r.signal;
    return m;
  }, [rows]);

  const stats = useMemo(() => {
    let advances = 0;
    let declines = 0;
    let unchanged = 0;
    let growth = 0;
    let sells = 0;
    let scored = 0;
    const moves: number[] = [];
    for (const r of rows) {
      if (!r.quote) continue;
      moves.push(r.pct);
      if (r.pct > 0) advances++;
      else if (r.pct < 0) declines++;
      else unchanged++;
      if (r.signal) {
        scored++;
        if (isBuy(r.signal.verdict)) growth++;
        else if (isSell(r.signal.verdict)) sells++;
      }
    }
    return { advances, declines, unchanged, growth, sells, scored, avg: average(moves) };
  }, [rows]);

  const groupNames = useMemo(() => {
    const present = new Set(rows.map((r) => groupOf(r.stock)));
    return GROUP_ORDER.filter((g) => present.has(g));
  }, [rows]);

  const groupAvg = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const g of groupNames) m.set(g, average(rows.filter((r) => r.quote && groupOf(r.stock) === g).map((r) => r.pct)));
    return m;
  }, [rows, groupNames]);

  const flaggedSell = useMemo(() => rows.filter((r) => r.signal && isSell(r.signal.verdict)), [rows]);
  const heldSell = useMemo(() => flaggedSell.filter((r) => heldSet.has(r.stock.symbol)), [flaggedSell, heldSet]);

  const { gainers, losers } = useMemo(() => {
    const live = rows.filter((r) => r.quote && !r.stock.custom).sort((a, b) => b.pct - a.pct);
    return {
      gainers: live.filter((r) => r.pct > 0).slice(0, 6),
      losers: live.filter((r) => r.pct < 0).slice(-6).reverse(),
    };
  }, [rows]);

  const watchRows = useMemo(() => rows.filter((r) => watchSet.has(r.stock.symbol)), [rows, watchSet]);

  const activeRows = useMemo(
    () =>
      rows
        .filter((r) => r.quote && !r.stock.custom && (r.quote.volume ?? 0) > 0)
        .sort((x, y) => y.price * (y.quote?.volume ?? 0) - x.price * (x.quote?.volume ?? 0))
        .slice(0, 6),
    [rows]
  );

  const sectorBars = useMemo(
    () => groupNames.filter((g) => g !== "Searched").map((g) => ({ name: g, avg: groupAvg.get(g) ?? null, count: rows.filter((r) => groupOf(r.stock) === g).length })),
    [groupNames, groupAvg, rows]
  );

  const groups: Group[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows.filter((r) => {
      if (!r.quote && missingSet.has(r.stock.symbol)) return false;
      if (group !== "All" && groupOf(r.stock) !== group) return false;
      if (filter === "watch" && !watchSet.has(r.stock.symbol)) return false;
      if (filter === "growth" && !(r.signal && isBuy(r.signal.verdict))) return false;
      if (filter === "sell" && !(r.signal && isSell(r.signal.verdict))) return false;
      return q === "" || r.stock.symbol.toLowerCase().includes(q) || r.stock.name.toLowerCase().includes(q);
    });
    const live = (r: Row) => (r.quote ? 0 : 1);
    if (sort === "gainers") list = [...list].sort((a, b) => live(a) - live(b) || b.pct - a.pct);
    else if (sort === "losers") list = [...list].sort((a, b) => live(a) - live(b) || a.pct - b.pct);
    else if (sort === "score") list = [...list].sort((a, b) => (b.signal?.score ?? -1) - (a.signal?.score ?? -1));
    else if (sort === "price") list = [...list].sort((a, b) => live(a) - live(b) || b.price - a.price);
    else if (sort === "name") list = [...list].sort((a, b) => a.stock.name.localeCompare(b.stock.name));

    if (view === "board" && sort === "default") {
      const byGroup = new Map<string, Row[]>();
      for (const r of list) {
        const g = groupOf(r.stock);
        const arr = byGroup.get(g) ?? [];
        arr.push(r);
        byGroup.set(g, arr);
      }
      return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => {
        const rs = byGroup.get(g) as Row[];
        return { name: g, rows: rs, avg: average(rs.filter((r) => r.quote).map((r) => r.pct)) };
      });
    }
    return [{ name: null, rows: list, avg: null }];
  }, [rows, query, group, filter, sort, view, watchSet, missingSet]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const flatSymbols = useMemo(() => flat.map((r) => r.stock.symbol), [flat]);

  const summary = useMemo(() => summarizePortfolio(holdings, quotes, universe), [holdings, quotes, universe]);

  // Raise each holding's trailing-stop peak when live prices make new highs.
  useEffect(() => {
    if (holdings.length === 0) return;
    let changed = false;
    const next = holdings.map((h) => {
      const ltp = quotes[h.symbol]?.ltp;
      if (ltp !== undefined && ltp > h.peak) {
        changed = true;
        return { ...h, peak: ltp };
      }
      return h;
    });
    if (changed) setHoldings(next);
  }, [quotes, holdings, setHoldings]);

  // Daily snapshot (at most one write per 5 s) for Sharpe and drawdown.
  useEffect(() => {
    if (holdings.length === 0 || !summary.hasLive) return;
    const t = Date.now();
    if (t - lastSnapshot.current < 5000) return;
    lastSnapshot.current = t;
    const point: HistoryPoint = { d: istDate(), v: summary.value, i: summary.invested };
    setHistory((prev) => {
      const idx = prev.findIndex((p) => p.d === point.d);
      if (idx >= 0) return prev.map((p, k) => (k === idx ? point : p));
      return [...prev, point].slice(-400);
    });
  }, [summary.value, summary.invested, summary.hasLive, holdings.length, setHistory]);

  const open = useCallback((symbol: string) => setOpenSymbol(symbol), []);
  const closeDrawer = useCallback(() => setOpenSymbol(null), []);

  const step = useCallback(
    (delta: number) => {
      if (!openSymbol || flatSymbols.length === 0) return;
      const i = flatSymbols.indexOf(openSymbol);
      const base = i === -1 ? 0 : i;
      setOpenSymbol(flatSymbols[(base + delta + flatSymbols.length) % flatSymbols.length]);
    },
    [openSymbol, flatSymbols]
  );

  // Keyboard: "/" or Ctrl/Cmd+K search, Esc close, arrows step through stocks while the drawer is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape") {
        if (showPortfolio) setShowPortfolio(false);
        else if (openSymbol) setOpenSymbol(null);
        else if (typing) (target as HTMLElement).blur();
      } else if (openSymbol && !typing && !showPortfolio) {
        if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSymbol, showPortfolio, step]);

  const toggleCollapsed = (name: string) =>
    setCollapsed((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));

  const doLookup = async () => {
    const sym = lookupText.trim().toUpperCase().replace(/\.NS$/, "");
    if (!sym) return;
    const existing = universe.find((st) => tickerOf(st.symbol) === sym);
    if (existing) {
      setLookupMsg({ tone: "ok", text: `${sym} is already on the board. Opening it.` });
      setOpenSymbol(existing.symbol);
      return;
    }
    setLookupBusy(true);
    setLookupMsg(null);
    try {
      const result = await lookupSymbol(sym);
      ingestExternal(result);
      setCustom((prev) => (prev.some((c) => c.symbol === result.key) ? prev : [{ symbol: result.key, name: result.name }, ...prev]));
      track([result.key]);
      setGroup("All");
      setFilter("all");
      setQuery("");
      setLookupText("");
      setLookupMsg({ tone: "ok", text: `${result.name} added to the top of the board at ₹${fmtINR(result.tick.ltp)}.` });
      setOpenSymbol(result.key);
    } catch (err) {
      setLookupMsg({ tone: "bad", text: err instanceof Error ? err.message : "Lookup failed." });
    } finally {
      setLookupBusy(false);
    }
  };

  const removeCustom = (symbol: string) => {
    setCustom((prev) => prev.filter((c) => c.symbol !== symbol));
    if (openSymbol === symbol) setOpenSymbol(null);
  };

  const openStock = openSymbol ? universe.find((st) => st.symbol === openSymbol) : undefined;
  const openIndex = openSymbol ? Math.max(0, flatSymbols.indexOf(openSymbol)) : 0;

  const silent = status === "live" && feed.receivedAt > 0 && now - feed.receivedAt > 20000;
  const stale = status === "live" && feed.source !== "none" && (silent || (feed.marketOpen && feed.stale));

  const bannerText =
    status === "offline"
      ? `Cannot reach the MarketMind backend at ${WS_URL}. Start it with: uvicorn app.live_main:app --port 8000`
      : status === "live" && feed.source === "none"
        ? feed.note || "The backend has no working data source yet."
        : stale
          ? silent
            ? "The backend has stopped sending updates. Prices on screen may be out of date. Check that uvicorn is still running."
            : "Data may be stale: no fresh prices have arrived for a while during market hours. Verify important prices in your broker before trading."
          : feed.note;

  const heldInfo = useMemo(() => {
    const m = new Map<string, { qty: number; pnlPct: number }>();
    for (const r of summary.rows) m.set(r.holding.symbol, { qty: r.holding.qty, pnlPct: r.pnlPct });
    return m;
  }, [summary]);

  const holdingsRef = useRef(holdings);
  holdingsRef.current = holdings;
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;

  /** The single place a paper trade happens: updates holdings and writes the journal entry. */
  const applyTrade = useCallback(
    (symbol: string, side: "buy" | "sell", qty: number, price: number) => {
      if (!(qty > 0) || !(price > 0)) return;
      const existing = holdingsRef.current.find((h) => h.symbol === symbol);
      if (side === "sell") {
        if (!existing) return;
        const sellQty = Math.min(qty, existing.qty);
        const realized = (price - existing.avgPrice) * sellQty;
        setHoldings((prev) =>
          prev.flatMap((h) => (h.symbol !== symbol ? [h] : h.qty - sellQty <= 0 ? [] : [{ ...h, qty: h.qty - sellQty }]))
        );
        setJournal((prev) => [...prev, { t: Date.now(), symbol, side, qty: sellQty, price, realized }].slice(-500));
        return;
      }
      const live = quotesRef.current[symbol]?.ltp ?? price;
      setHoldings((prev) => {
        const ex = prev.find((h) => h.symbol === symbol);
        if (!ex) return [...prev, { symbol, qty, avgPrice: price, peak: Math.max(price, live) }];
        const total = ex.qty + qty;
        return prev.map((h) =>
          h.symbol === symbol ? { ...h, qty: total, avgPrice: (ex.qty * ex.avgPrice + qty * price) / total, peak: Math.max(h.peak, live) } : h
        );
      });
      setJournal((prev) => [...prev, { t: Date.now(), symbol, side, qty, price }].slice(-500));
    },
    [setHoldings, setJournal]
  );

  const tradeOne = useCallback(
    (symbol: string, dir: 1 | -1) => {
      const ltp = quotesRef.current[symbol]?.ltp;
      if (ltp) applyTrade(symbol, dir === 1 ? "buy" : "sell", 1, ltp);
    },
    [applyTrade]
  );

  const histStats = useMemo(() => portfolioFromHistory(holdings, analytics), [holdings, analytics]);

  const exportBackup = useCallback(() => {
    downloadBackup({
      app: "marketmind",
      version: 1,
      exportedAt: new Date().toISOString(),
      holdings,
      history,
      journal,
      watch,
      custom,
      riskBudget,
    });
  }, [holdings, history, journal, watch, custom, riskBudget]);

  const importBackup = useCallback(
    (text: string): string => {
      const res = parseBackup(text);
      if (!res.ok) return res.reason;
      const d = res.data;
      if (!window.confirm(`Replace your current portfolio with the backup (${d.holdings.length} positions, ${d.journal.length} journal entries)?`)) {
        return "Import cancelled.";
      }
      setHoldings(d.holdings);
      setHistory(d.history);
      setJournal(d.journal);
      setWatch(d.watch.length ? d.watch : STARTER_WATCH);
      setCustom(d.custom);
      setRiskBudget(d.riskBudget);
      return `Imported ${d.holdings.length} positions and ${d.journal.length} journal entries.`;
    },
    [setHoldings, setHistory, setJournal, setWatch, setCustom, setRiskBudget]
  );

  // Browser alert when a held stock newly crosses its trailing stop (only if the person enabled notifications).
  const alerted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const r of summary.rows) {
      const k = r.holding.symbol;
      if (r.stopHit && r.hasLive && !alerted.current.has(k)) {
        alerted.current.add(k);
        try {
          new Notification(`${tickerOf(k)} hit its trailing stop`, { body: `Last price ₹${fmtINR(r.ltp)}, stop ₹${fmtINR(r.stopPrice)}. Paper position: review it.` });
        } catch {
          /* notifications blocked */
        }
      } else if (!r.stopHit) {
        alerted.current.delete(k);
      }
    }
  }, [summary]);

  const viewTile = (r: Row) => ({
    row: r,
    starred: watchSet.has(r.stock.symbol),
    held: heldSet.has(r.stock.symbol),
    heldQty: heldInfo.get(r.stock.symbol)?.qty ?? 0,
    heldPnlPct: heldInfo.get(r.stock.symbol)?.pnlPct ?? null,
    riskBudget,
    evidence,
    marketOpen: feed.marketOpen,
    nowMin: Math.floor(now / 60000),
    active: openSymbol === r.stock.symbol,
    onOpen: open,
    onStar: toggleWatch,
    onTrade: tradeOne,
  });

  const filterButtons: { id: SignalFilter; label: string; count?: number }[] = [
    { id: "all", label: "All stocks", count: rows.length },
    { id: "watch", label: "Watchlist", count: watch.length },
    { id: "growth", label: "🚀 Growth", count: stats.growth },
    { id: "sell", label: "⚠️ Sell alerts", count: stats.sells },
  ];

  return (
    <div className="app">
      <style>{CSS}</style>

      <MarketRibbon quotes={quotes} status={status} feed={feed} now={now} />

      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22">
                <g stroke="#0b0b0d" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M6 4v3M6 15v4M12 2v4M12 13v5M18 5v2M18 12v3" />
                </g>
                <rect x="4" y="7" width="4" height="8" rx="1.2" fill="#0b0b0d" />
                <rect x="10" y="6" width="4" height="7" rx="1.2" fill="#0b0b0d" opacity=".55" />
                <rect x="16" y="7" width="4" height="5" rx="1.2" fill="#0b0b0d" />
              </svg>
            </span>
            <span className="brand-name">MarketMind</span>
          </div>
          <label className="search">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              placeholder="Search by company or symbol"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search stocks"
            />
            <kbd>/</kbd>
          </label>
          <button className="btn btn-accent" onClick={() => setShowPortfolio(true)}>
            Portfolio
            {holdings.length > 0 && <span className="badge">{holdings.length}</span>}
          </button>
        </div>
      </header>

      {bannerText && (
        <div className={`banner ${status === "offline" || feed.source === "none" || silent ? "banner-bad" : "banner-warn"}`} role="status">
          {bannerText}
        </div>
      )}

      <AlertBanner
        flagged={flaggedSell}
        held={heldSell}
        onOpen={open}
        onShow={() => {
          setFilter("sell");
          setGroup("All");
        }}
      />

      <main className="shell">
        <nav className="rail" aria-label="Filters">
          <div className="rail-block">
            <div className="rail-title">Signals</div>
            {filterButtons.map((f) => (
              <button key={f.id} className={`rail-btn ${filter === f.id ? "rail-on" : ""}`} onClick={() => setFilter(f.id)}>
                <span>{f.label}</span>
                <span className="rail-count">{f.count}</span>
              </button>
            ))}
          </div>
          <div className="rail-block">
            <div className="rail-title">Sectors</div>
            <button className={`rail-btn ${group === "All" ? "rail-on" : ""}`} onClick={() => setGroup("All")}>
              <span>Every sector</span>
            </button>
            {groupNames.map((g) => {
              const avg = groupAvg.get(g) ?? null;
              return (
                <button key={g} className={`rail-btn ${group === g ? "rail-on" : ""}`} onClick={() => setGroup(group === g ? "All" : g)}>
                  <span>{g}</span>
                  {avg !== null && <span className={`rail-avg ${avg >= 0 ? "txt-up" : "txt-down"}`}>{fmtPct(avg)}</span>}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="center">
          <Pulse
            advances={stats.advances}
            declines={stats.declines}
            unchanged={stats.unchanged}
            avg={stats.avg}
            total={universe.length}
            growth={stats.growth}
            sells={stats.sells}
            scored={stats.scored}
          />

          <div className="controls">
            <div className="seg" role="group" aria-label="View">
              <button className={view === "board" ? "seg-on" : ""} onClick={() => setView("board")} aria-pressed={view === "board"}>
                Board
              </button>
              <button className={view === "list" ? "seg-on" : ""} onClick={() => setView("list")} aria-pressed={view === "list"}>
                List
              </button>
            </div>
            <span className="muted small count">
              {flat.length} of {universe.length} stocks
            </span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort stocks">
              <option value="default">Group by sector</option>
              <option value="score">Highest quant score</option>
              <option value="gainers">Biggest gainers first</option>
              <option value="losers">Biggest losers first</option>
              <option value="price">Highest price first</option>
              <option value="name">Name, A to Z</option>
            </select>
          </div>

          {view === "board" ? (
            <div className="board">
              {groups.map((g) => {
                const isCollapsed = g.name !== null && collapsed.includes(g.name);
                return (
                  <section key={g.name ?? "flat"} className="group">
                    {g.name !== null && (
                      <button className="group-head" onClick={() => toggleCollapsed(g.name as string)} aria-expanded={!isCollapsed}>
                        <span className={`caret ${isCollapsed ? "" : "caret-open"}`} aria-hidden="true">
                          ›
                        </span>
                        <span className="group-name">{g.name}</span>
                        <span className="muted small">{g.rows.length} stocks</span>
                        {g.avg !== null && <span className={`pill ${g.avg >= 0 ? "pill-up" : "pill-down"}`}>{fmtPct(g.avg)}</span>}
                        {g.name === "Searched" && <span className="muted small grow">fetched with Live Quant</span>}
                      </button>
                    )}
                    {!isCollapsed && (
                      <div className="tiles-grid">
                        {g.rows.map((r) => (
                          <div key={r.stock.symbol} className="tile-wrap">
                            <Tile {...viewTile(r)} />
                            {r.stock.custom && (
                              <button className="tile-x" onClick={() => removeCustom(r.stock.symbol)} aria-label={`Remove ${r.stock.name}`}>
                                ✕
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="list" role="list">
              {flat.map((r) => (
                <ListRow key={r.stock.symbol} {...viewTile(r)} />
              ))}
            </div>
          )}

          {flat.length === 0 && (
            <div className="empty">
              {filter === "watch" && watch.length === 0
                ? "Your watchlist is empty. Click the star on any stock to add it."
                : filter === "sell" || filter === "growth"
                  ? "No stocks carry that signal in this view. Try \"Every sector\" or clear the search."
                  : "No stocks match these filters. Clear the search or pick another sector."}
            </div>
          )}
          <div className="dock-space" />
        </div>

        <aside className="side">
          <MoverList title="Top gainers" rows={gainers} empty="Waiting for live prices." onPick={open} />
          <MoverList title="Top losers" rows={losers} empty="Waiting for live prices." onPick={open} />
          <MoverList title="Watchlist" rows={watchRows} empty="Star a stock to keep it here." onPick={open} />
          <SectorBars items={sectorBars} onPick={(name) => setGroup(group === name ? "All" : name)} />
          <ActiveList rows={activeRows} onPick={open} />
          <DataHealthPanel
            feed={feed}
            nowMs={now}
            status={status}
            priced={rows.filter((r) => r.quote && !r.stock.custom).length}
            total={rows.filter((r) => !r.stock.custom).length}
            withHistory={rows.filter((r) => !r.stock.custom && analytics[r.stock.symbol]).length}
            missing={feed.missing}
            stale={stale}
          />
          <TrackRecordPanel data={backtest.data} error={backtest.error} />
        </aside>
      </main>

      <footer className="site-foot">
        MarketMind shows rule-based readings of price action, not predictions or investment advice. Buy and Sell here are paper trades kept
        in this browser; nothing is sent to a broker. Prices come from public or delayed sources unless a broker feed is connected, so
        confirm any price with your broker before you trade. Check the Signal track record panel before trusting a label.
      </footer>

      <LookupDock value={lookupText} busy={lookupBusy} message={lookupMsg} onChange={setLookupText} onSubmit={doLookup} />

      {openStock && (
        <Drawer
          stock={openStock}
          quote={quotes[openStock.symbol]}
          ana={analytics[openStock.symbol]}
          signal={signals[openStock.symbol] ?? null}
          row={summary.rows.find((r) => r.holding.symbol === openStock.symbol)}
          starred={watchSet.has(openStock.symbol)}
          feed={feed}
          index={openIndex}
          count={flatSymbols.length}
          riskBudget={riskBudget}
          setRiskBudget={setRiskBudget}
          onClose={closeDrawer}
          onStep={step}
          onStar={toggleWatch}
          onPortfolio={() => setShowPortfolio(true)}
        />
      )}

      {showPortfolio && (
        <PortfolioModal
          summary={summary}
          history={history}
          stocks={universe}
          quotes={quotes}
          analytics={analytics}
          signals={signals}
          journal={journal}
          histStats={histStats}
          onTrade={applyTrade}
          onExport={exportBackup}
          onImport={importBackup}
          onClose={() => setShowPortfolio(false)}
          onOpen={(s) => {
            setShowPortfolio(false);
            setOpenSymbol(s);
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------- Styles -------------------------------- */

const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700&family=DM+Sans:wght@400;500;600&display=swap");

:root{
  --bg:#0b0b0d; --bg2:#121113; --surface:#1d1b1a; --raised:#2d2926; --line:rgba(255,255,255,.07); --line2:rgba(255,255,255,.14);
  --ink:#fafaf9; --muted:#c4beb4; --faint:#948d82;
  --up:#00f5a0; --down:#ff4d7d; --violet:#ff8a3d; --cyan:#00e5ff; --amber:#ffe14d;
  --display:"Sora","DM Sans",system-ui,sans-serif; --body:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --r-tile:18px; --r-panel:22px; --r-pill:999px;
  --glow:0 18px 40px -18px rgba(255,138,61,.55);
}
*{box-sizing:border-box}
html,body,#root{margin:0!important;padding:0!important;min-height:100%;width:100%!important;max-width:none!important;text-align:left!important;display:block!important;place-items:initial!important}
body{background:var(--bg);color:var(--ink);font-family:var(--body);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.app{min-height:100vh;background:
  radial-gradient(900px 520px at 8% -8%,rgba(255,138,61,.16),transparent 60%),
  radial-gradient(820px 480px at 96% 4%,rgba(0,229,255,.11),transparent 60%),
  var(--bg)}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
button:disabled{cursor:not-allowed;opacity:.5}
:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.muted{color:var(--muted)} .small{font-size:12px} .grow{flex:1}
.txt-up{color:var(--up)} .txt-down{color:var(--down)} .txt-cyan{color:var(--cyan)}

/* ---------- Ribbon ---------- */
.ribbon{position:sticky;top:0;z-index:60;background:rgba(8,12,24,.82);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.ribbon-inner{max-width:1600px;margin:0 auto;display:flex;align-items:center;gap:20px;padding:0 24px;height:48px}
.ribbon-scroll{display:flex;gap:30px;overflow-x:auto;flex:1;scrollbar-width:none;white-space:nowrap}
.ribbon-scroll::-webkit-scrollbar{display:none}
.ribbon-item{display:flex;align-items:baseline;gap:8px;font-size:13px}
.ribbon-label{font-weight:500;color:var(--muted);font-size:12px}
.ribbon-value{font-weight:600}
.feed{display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap;padding:5px 12px;border-radius:var(--r-pill);background:rgba(255,255,255,.06);border:1px solid var(--line)}
.feed-dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.feed-ok .feed-dot{background:var(--up);animation:ping 2.2s infinite}
.feed-warn .feed-dot{background:var(--amber)} .feed-bad .feed-dot{background:var(--down)}
.feed-text{font-weight:600} .feed-age{color:var(--muted)}
@keyframes ping{0%{box-shadow:0 0 0 0 rgba(0,245,160,.5)}70%{box-shadow:0 0 0 8px rgba(0,245,160,0)}100%{box-shadow:0 0 0 0 rgba(0,245,160,0)}}

/* ---------- Top bar ---------- */
.topbar{border-bottom:1px solid var(--line)}
.topbar-inner{max-width:1600px;margin:0 auto;display:flex;align-items:center;gap:20px;padding:14px 24px}
.brand{display:flex;align-items:center;gap:11px}
.brand-mark{width:38px;height:38px;border-radius:50%;background:linear-gradient(145deg,var(--amber),var(--violet));display:grid;place-items:center;box-shadow:var(--glow)}
.brand-name{font-family:var(--display);font-weight:700;font-size:21px;letter-spacing:-.03em}
.search{flex:1;max-width:580px;display:flex;align-items:center;gap:10px;height:44px;padding:0 16px;border:1px solid var(--line);background:rgba(255,255,255,.04);border-radius:var(--r-pill);color:var(--muted);transition:border-color .15s,background-color .15s,box-shadow .15s}
.search:focus-within{border-color:var(--violet);background:rgba(255,255,255,.07);box-shadow:0 0 0 4px rgba(255,138,61,.18)}
.search input{flex:1;min-width:0;border:none;background:transparent;outline:none;color:var(--ink)}
.search input::placeholder{color:var(--faint)}
.search kbd{font:500 11px var(--body);border:1px solid var(--line2);border-radius:6px;padding:1px 7px;color:var(--muted)}

/* ---------- Buttons ---------- */
.btn{height:44px;border-radius:var(--r-pill);border:1px solid var(--line2);background:rgba(255,255,255,.04);padding:0 20px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:transform .12s,filter .15s,background-color .15s}
.btn:active:not(:disabled){transform:scale(.97)}
.btn-accent{background:linear-gradient(135deg,var(--violet),var(--cyan));border:none;color:#070b16;box-shadow:var(--glow)}
.btn-accent:hover:not(:disabled){filter:brightness(1.1)}
.btn-ghost:hover{background:rgba(255,255,255,.08)}
.btn-on{background:rgba(255,225,77,.14);border-color:rgba(255,225,77,.5);color:var(--amber)}
.btn-primary{background:var(--ink);color:#070b16;border-color:var(--ink)}
.btn-wide{width:100%;margin-top:22px}
.badge{background:#070b16;color:var(--ink);border-radius:var(--r-pill);font-size:11px;padding:1px 8px}
.icon-btn{border:none;background:transparent;color:var(--muted);font-size:16px;padding:7px 10px;border-radius:10px}
.icon-btn:hover{background:rgba(255,255,255,.08);color:var(--ink)}

/* ---------- Banners ---------- */
.banner{padding:11px 24px;font-size:13px;text-align:center;border-bottom:1px solid}
.banner-bad{background:rgba(255,77,125,.12);color:#ffa3bb;border-color:rgba(255,77,125,.3)}
.banner-warn{background:rgba(255,225,77,.1);color:#ffd08a;border-color:rgba(255,225,77,.28)}
.alert{max-width:1600px;margin:14px auto 0;display:flex;align-items:center;gap:14px;padding:12px 18px;border-radius:16px;background:linear-gradient(90deg,rgba(255,77,125,.16),rgba(255,77,125,.05));border:1px solid rgba(255,77,125,.35);width:calc(100% - 48px)}
.alert-held{background:linear-gradient(90deg,rgba(255,225,77,.2),rgba(255,77,125,.1));border-color:rgba(255,225,77,.5)}
.alert-text{flex:1;font-size:13.5px;line-height:1.5}
.alert-link{border:none;background:transparent;color:var(--ink);font-weight:700;text-decoration:underline;padding:0}
.alert-btn{border:1px solid var(--line2);background:rgba(255,255,255,.06);border-radius:var(--r-pill);padding:7px 14px;font-weight:600;font-size:12.5px;white-space:nowrap}
.alert-btn:hover{background:rgba(255,255,255,.12)}

/* ---------- Shell ---------- */
.shell{max-width:1920px;margin:0 auto;display:grid;grid-template-columns:232px minmax(0,1fr) 316px;gap:24px;padding:20px 24px 24px;align-items:start}
.center{min-width:0}
.rail{position:sticky;top:68px;display:flex;flex-direction:column;gap:18px}
.rail-block{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:var(--r-panel);padding:10px}
.rail-title{font-family:var(--display);font-size:13px;font-weight:600;color:var(--muted);padding:6px 10px 8px}
.rail-btn{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;border:none;background:transparent;text-align:left;padding:9px 10px;border-radius:12px;font-size:13.5px;font-weight:500;transition:background-color .12s}
.rail-btn:hover{background:rgba(255,255,255,.06)}
.rail-on{background:linear-gradient(135deg,rgba(255,138,61,.28),rgba(0,229,255,.16));box-shadow:inset 0 0 0 1px rgba(255,138,61,.45)}
.rail-count{font-size:11.5px;color:var(--muted);background:rgba(255,255,255,.07);border-radius:var(--r-pill);padding:1px 8px}
.rail-avg{font-size:12px;font-weight:600}
.side{position:sticky;top:68px;display:flex;flex-direction:column;gap:16px;max-height:calc(100vh - 150px);overflow:auto;scrollbar-width:thin}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-panel);padding:16px 16px 8px}
.panel-title{margin:0 0 6px;font-family:var(--display);font-size:15px;font-weight:600}

/* ---------- Pulse ---------- */
.pulse{position:relative;overflow:hidden;border-radius:26px;padding:22px 24px;margin-bottom:18px;background:
  radial-gradient(520px 200px at 100% 0%,rgba(255,138,61,.28),transparent 70%),
  radial-gradient(420px 220px at 0% 100%,rgba(0,229,255,.18),transparent 70%),
  var(--surface);border:1px solid var(--line2)}
.pulse-main{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}
.pulse-kicker{font-size:12px;color:var(--muted);margin-bottom:2px}
.pulse-mood{font-family:var(--display);font-size:28px;font-weight:700;letter-spacing:-.03em}
.pulse-avg{display:flex;flex-direction:column;align-items:flex-end}
.pulse-avg-val{font-family:var(--display);font-size:32px;font-weight:700;letter-spacing:-.03em}
.breadth-bar{display:flex;height:12px;border-radius:var(--r-pill);overflow:hidden;background:rgba(255,255,255,.07);gap:2px}
.breadth-adv{background:linear-gradient(90deg,#1fbf8a,var(--up));transition:width .5s ease}
.breadth-unch{background:rgba(255,255,255,.2);transition:width .5s ease}
.breadth-dec{background:linear-gradient(90deg,var(--down),#ff8aa0);transition:width .5s ease}
.pulse-stats{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:14px;font-size:13px;align-items:center}
.pulse-sep{width:1px;height:14px;background:var(--line2)}

/* ---------- Controls ---------- */
.controls{display:flex;align-items:center;gap:14px;margin:4px 0 16px}
.controls select{margin-left:auto;height:40px;border:1px solid var(--line2);border-radius:var(--r-pill);background:var(--surface);padding:0 14px}
.seg{display:inline-flex;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:var(--r-pill);padding:3px}
.seg button{border:none;background:transparent;border-radius:var(--r-pill);padding:7px 18px;font-weight:600;font-size:13px;color:var(--muted)}
.seg .seg-on{background:linear-gradient(135deg,var(--violet),var(--cyan));color:#070b16}
.seg-small{margin:20px 0 10px} .seg-small button{padding:5px 14px;font-size:12.5px}

/* ---------- Board ---------- */
.board{display:flex;flex-direction:column;gap:24px}
.group-head{display:flex;align-items:center;gap:10px;width:100%;border:none;background:transparent;padding:4px 2px 12px;text-align:left}
.group-name{font-family:var(--display);font-size:18px;font-weight:600;letter-spacing:-.02em}
.caret{display:inline-block;font-size:20px;line-height:1;color:var(--muted);transition:transform .18s}
.caret-open{transform:rotate(90deg)}
.pill{font-size:12px;font-weight:600;border-radius:var(--r-pill);padding:3px 10px}
.pill-up{background:rgba(0,245,160,.14);color:var(--up)} .pill-down{background:rgba(255,77,125,.14);color:var(--down)}
.tiles-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:12px}
.tile-wrap{position:relative;content-visibility:auto;contain-intrinsic-size:auto 330px}
.tile-x{position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;border:1px solid var(--line2);background:var(--raised);color:var(--muted);font-size:11px;display:none;place-items:center;z-index:3}
.tile-wrap:hover .tile-x{display:grid}

.tile-card{position:relative;overflow:hidden;display:flex;flex-direction:column;gap:3px;min-height:150px;padding:14px 15px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-tile);cursor:pointer;transition:transform .18s cubic-bezier(.2,.8,.2,1),box-shadow .18s,border-color .25s;outline-offset:3px;backdrop-filter:blur(4px)}
.tile-card:hover{transform:translateY(-4px);box-shadow:0 18px 36px -14px rgba(0,0,0,.75),0 0 0 1px rgba(255,255,255,.12);z-index:2}
.tile-active{box-shadow:0 0 0 2px var(--cyan)!important}
.tile-top{display:flex;justify-content:space-between;align-items:center;min-height:24px}
.tile-sym{font-family:var(--display);font-weight:600;font-size:15px;letter-spacing:-.02em}
.tile-badges{display:flex;align-items:center;gap:4px}
.tile-namerow{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.tile-name{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.tile-namerow .spark{width:44px;flex:none}
.tile-mid{display:flex;justify-content:space-between;align-items:baseline;gap:6px;margin-top:auto;padding-top:12px}
.tile-price{font-size:19px;font-weight:600;letter-spacing:-.02em}
.tile-pct{font-size:12.5px;font-weight:700;white-space:nowrap}
.tile-bottom{display:flex;justify-content:space-between;align-items:center;margin-top:8px;min-height:34px}
.tile-end{display:flex;align-items:center;gap:10px}
.tile-ping{position:absolute;inset:0;border-radius:inherit;pointer-events:none;animation:flash .7s ease-out forwards}
.ping-up{box-shadow:inset 0 0 0 2px rgba(0,245,160,.9),inset 0 0 30px rgba(0,245,160,.35)}
.ping-down{box-shadow:inset 0 0 0 2px rgba(255,77,125,.9),inset 0 0 30px rgba(255,77,125,.35)}
@keyframes flash{from{opacity:1}to{opacity:0}}
.spark{width:56px;height:22px} .spark-none{display:inline-block}
.dot-held{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--amber);box-shadow:0 0 0 2px rgba(255,225,77,.25)}

.ring{display:inline-grid;place-items:center;border-radius:50%;flex:none}
.ring-in{display:grid;place-items:center;width:calc(100% - 7px);height:calc(100% - 7px);border-radius:50%;background:var(--surface);font-weight:700}
.vchip{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.01em;border-radius:var(--r-pill);padding:3px 9px;white-space:nowrap}
.v-strong{background:rgba(0,245,160,.16);color:var(--up)}
.v-accum{background:rgba(0,229,255,.16);color:var(--cyan)}
.v-hold{background:rgba(255,225,77,.16);color:var(--amber)}
.v-sell{background:rgba(255,77,125,.18);color:var(--down)}
.v-none{background:transparent;color:var(--faint);font-weight:500}

.star{border:none;background:transparent;color:var(--faint);padding:4px;border-radius:8px;display:grid;place-items:center;opacity:0;transition:opacity .15s,color .15s,transform .15s}
.tile-card:hover .star,.star:focus-visible,.lrow:hover .star,.star-on{opacity:1}
.star:hover{color:var(--amber);transform:scale(1.15)}
.star-on{color:var(--amber)!important}

.shimmer{display:inline-block;width:92px;height:18px;border-radius:8px;background:linear-gradient(90deg,rgba(255,255,255,.05) 25%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.05) 75%);background-size:200% 100%;animation:shine 1.4s infinite linear;vertical-align:middle}
.shimmer-sm{width:60px;height:12px} .shimmer-lg{width:200px;height:40px;border-radius:10px}
@keyframes shine{to{background-position:-200% 0}}

/* ---------- List ---------- */
.list{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:var(--r-panel);overflow:hidden}
.lrow{display:grid;grid-template-columns:34px minmax(150px,1.5fr) .9fr 118px 40px 70px 1fr 82px;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 56px;transition:background-color .12s}
.lrow:last-child{border-bottom:none}
.lrow:hover,.lrow-active{background:rgba(255,255,255,.05)}
.lrow-id{display:flex;flex-direction:column;min-width:0}
.lrow-sym{font-weight:600;font-size:14px}
.lrow-name{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lrow-sector{font-size:12px;color:var(--muted)}
.lrow-rsi{font-size:12px;color:var(--muted)}
.lrow-price{text-align:right;font-weight:600}
.lrow-pct{text-align:right;font-weight:700}

/* ---------- Movers ---------- */
.movers{list-style:none;margin:0;padding:0}
.mover{display:flex;justify-content:space-between;gap:10px;width:100%;border:none;background:transparent;text-align:left;padding:10px 8px;margin:0 -8px;border-radius:12px;transition:background-color .12s}
.mover:hover{background:rgba(255,255,255,.06)}
.mover-id{display:flex;flex-direction:column;min-width:0}
.mover-sym{font-weight:600;font-size:13.5px}
.mover-name{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mover-right{display:flex;flex-direction:column;align-items:flex-end;font-size:12.5px;font-weight:600}
.panel .muted.small{padding-bottom:10px}

/* ---------- Drawer ---------- */
.scrim{position:fixed;inset:0;background:rgba(2,4,10,.62);backdrop-filter:blur(3px);z-index:80;animation:fade .18s ease-out}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);background:linear-gradient(180deg,#0f1730,#0a1020);border-left:1px solid var(--line2);z-index:90;display:flex;flex-direction:column;box-shadow:-30px 0 70px -20px rgba(0,0,0,.8);animation:slide .24s cubic-bezier(.2,.8,.2,1)}
@keyframes slide{from{transform:translateX(44px);opacity:0}to{transform:none;opacity:1}}
@keyframes fade{from{opacity:0}to{opacity:1}}
.drawer-bar{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}
.drawer-nav{display:flex;align-items:center;gap:6px}
.drawer-body{padding:20px 24px 40px;overflow:auto}
.drawer-title{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.drawer-sym{margin:0;font-family:var(--display);font-size:32px;font-weight:700;letter-spacing:-.04em}
.tag{font-size:11px;color:var(--muted);background:rgba(255,255,255,.07);border-radius:8px;padding:2px 8px;margin-left:6px}
.drawer-price-row{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-top:18px}
.drawer-price{font-family:var(--display);font-size:42px;font-weight:700;letter-spacing:-.04em}
.chg{font-weight:600;font-size:14px}
.drawer-asof{margin:4px 0 18px}
.quant{margin:4px 0 6px;padding:16px;border-radius:20px;background:rgba(255,255,255,.04);border:1px solid var(--line)}
.quant-empty{padding:14px 16px}
.quant-head{display:flex;align-items:center;gap:16px}
.quant-head-text{display:flex;flex-direction:column;gap:6px;flex:1}
.quant-head-text .vchip{font-size:12.5px;padding:4px 12px;align-self:flex-start}
.quant-rsi{display:flex;flex-direction:column;align-items:flex-end}
.quant-rsi-val{font-family:var(--display);font-size:24px;font-weight:700}
.gauge{margin-top:16px}
.gauge-track{position:relative;height:8px;border-radius:var(--r-pill);background:rgba(255,255,255,.1)}
.gauge-zone{position:absolute;top:0;bottom:0}
.gauge-low{left:0;width:30%;background:rgba(0,245,160,.45);border-radius:var(--r-pill) 0 0 var(--r-pill)}
.gauge-high{right:0;width:30%;background:rgba(255,77,125,.45);border-radius:0 var(--r-pill) var(--r-pill) 0}
.gauge-dot{position:absolute;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:#fff;border:3px solid var(--violet);box-shadow:0 2px 8px rgba(0,0,0,.5)}
.gauge-scale{display:flex;justify-content:space-between;font-size:11px;color:var(--faint);margin-top:6px}
.catalysts{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.catalysts li{font-size:13px;padding:7px 12px;border-radius:10px;background:rgba(255,138,61,.12);border:1px solid rgba(255,138,61,.25)}
.chart-wrap{position:relative;height:260px;border:1px solid var(--line);border-radius:var(--r-tile);overflow:hidden;background:rgba(255,255,255,.025)}
.chart-el{position:absolute;inset:0;width:100%;height:100%}
.chart-empty{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:13px;text-align:center;padding:0 24px;pointer-events:none}
.chart-note{margin:8px 2px 0;line-height:1.5}
.range{margin-top:22px}
.range-head{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:8px}
.range-track{position:relative;height:8px;border-radius:var(--r-pill);background:linear-gradient(90deg,rgba(255,77,125,.3),rgba(255,255,255,.1) 50%,rgba(0,245,160,.3))}
.range-now{position:absolute;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #0a1020;box-shadow:0 1px 6px rgba(0,0,0,.6);transition:left .4s ease}
.range-up{background:var(--up)} .range-down{background:var(--down)}
.range-prev{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--ink);opacity:.5;border-radius:2px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:14px 18px;margin-top:22px}
.stat{display:flex;flex-direction:column;gap:3px}
.stat-label{font-size:12px;color:var(--muted)}
.stat-value{font-size:15px;font-weight:600}
.sizing,.holding{margin-top:24px;padding:16px 18px;border-radius:20px;background:rgba(255,255,255,.04);border:1px solid var(--line)}
.holding-title{font-family:var(--display);font-weight:600;font-size:15px}
.sizing-row{display:flex;gap:18px;align-items:flex-end;margin-top:12px;flex-wrap:wrap}
.sizing-input{display:flex;flex-direction:column;gap:5px}
.sizing-input input{height:42px;width:150px;border:1px solid var(--line2);border-radius:12px;background:rgba(0,0,0,.25);padding:0 12px;outline:none}
.sizing-input input:focus{border-color:var(--violet)}
.sizing-result{display:flex;flex-direction:column}
.sizing-qty{font-family:var(--display);font-size:26px;font-weight:700;color:var(--cyan)}
.holding .stats{margin-top:14px}
.stop-hit{color:#fff;background:var(--down);font-size:11px;font-weight:700;border-radius:var(--r-pill);padding:3px 12px;display:inline-block;margin-top:10px}
.fineprint{font-size:12px;color:var(--faint);margin:20px 0 0;line-height:1.55}

/* ---------- Portfolio modal ---------- */
.modal-backdrop{position:fixed;inset:0;background:rgba(2,4,10,.7);backdrop-filter:blur(4px);z-index:100;display:grid;place-items:center;padding:20px;animation:fade .15s ease-out}
.modal{background:linear-gradient(180deg,#0f1730,#0a1020);border:1px solid var(--line2);border-radius:26px;width:min(1040px,100%);max-height:92vh;overflow:auto;padding:26px;box-shadow:0 40px 90px rgba(0,0,0,.7)}
.modal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.modal-head h2{margin:0 0 3px;font-family:var(--display);font-size:24px;letter-spacing:-.03em}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(172px,1fr));gap:12px;margin:20px 0}
.mtile{background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:16px;padding:13px 15px;display:flex;flex-direction:column;gap:4px}
.mtile-label{font-size:12px;color:var(--muted)} .mtile-value{font-size:15.5px;font-weight:700}
.add-row{display:grid;grid-template-columns:1.4fr 1fr 1fr auto;gap:10px}
.add-row input{height:44px;border:1px solid var(--line2);border-radius:var(--r-pill);background:rgba(0,0,0,.25);padding:0 16px;outline:none;min-width:0}
.add-row input:focus{border-color:var(--violet)}
.form-error{color:var(--down);font-size:13px;margin-top:8px}
.holds{display:flex;flex-direction:column;gap:14px;margin-top:18px}
.hold{padding:16px 18px;border-radius:20px;background:rgba(255,255,255,.035);border:1px solid var(--line)}
.hold-stop{border-color:rgba(255,77,125,.55);background:rgba(255,77,125,.07)}
.hold-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.hold-id{display:flex;flex-direction:column;align-items:flex-start;border:none;background:transparent;padding:0;text-align:left;flex:1;min-width:120px}
.hold-sym{font-family:var(--display);font-weight:700;font-size:18px}
.hold-pnl{display:flex;flex-direction:column;align-items:flex-end;font-weight:700;font-size:16px}
.hold-pnl small{font-size:12px;font-weight:600}
.advice{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.advice li{font-size:13px;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.05);line-height:1.45}
.adv-good{background:rgba(0,245,160,.12)!important;color:#9dffd5}
.adv-bad{background:rgba(255,77,125,.14)!important;color:#ffa3bb}
.adv-none{color:var(--muted)}
.empty{padding:44px 20px;text-align:center;color:var(--muted);line-height:1.6}

/* ---------- Live Quant dock ---------- */
.dock{position:fixed;left:0;right:0;bottom:0;z-index:70;background:rgba(8,12,24,.86);backdrop-filter:blur(14px);border-top:1px solid var(--line2)}
.dock-inner{max-width:1600px;margin:0 auto;display:flex;align-items:center;gap:14px;padding:12px 24px;flex-wrap:wrap}
.dock-copy{display:flex;flex-direction:column;min-width:190px}
.dock-title{font-family:var(--display);font-weight:600;font-size:14px}
.dock-inner input{flex:1;min-width:200px;max-width:420px;height:42px;border:1px solid var(--line2);border-radius:var(--r-pill);background:rgba(255,255,255,.05);padding:0 16px;outline:none;letter-spacing:.02em}
.dock-inner input:focus{border-color:var(--cyan)}
.dock-inner .btn{height:42px}
.dock-msg{font-size:13px;flex:1;min-width:200px}
.dock-space{height:96px}

@media (max-width:1320px){
  .shell{grid-template-columns:minmax(0,1fr);gap:16px}
  .rail{position:static;flex-direction:row;overflow-x:auto;gap:12px;scrollbar-width:none}
  .rail-block{display:flex;gap:6px;align-items:center;padding:6px;flex:none}
  .rail-title{display:none}
  .rail-btn{width:auto;white-space:nowrap}
  .side{position:static;max-height:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
}
@media (max-width:760px){
  .topbar-inner{flex-wrap:wrap}
  .search{order:3;max-width:none;flex-basis:100%}
  .shell,.topbar-inner,.ribbon-inner,.dock-inner{padding-left:14px;padding-right:14px}
  .alert{width:calc(100% - 28px);flex-wrap:wrap}
  .feed-age{display:none}
  .add-row{grid-template-columns:1fr 1fr}
  .lrow{grid-template-columns:30px minmax(0,1fr) 92px 90px}
  .lrow-sector,.lrow-score,.lrow-rsi,.lrow-verdict{display:none}
  .tiles-grid{grid-template-columns:minmax(0,1fr)}
  .tile-namerow .spark{display:none}
  .pulse{padding:18px}
  .pulse-mood{font-size:22px}
  .controls{gap:10px}
  .controls>.count{display:none}
  .controls select{flex:1;min-width:0;margin-left:0}
  .drawer{width:100%}
  .dock-copy{display:none}
  .dock-inner{gap:8px;padding-top:10px;padding-bottom:10px}
  .dock-inner input{min-width:0;flex:1;height:40px}
  .dock-inner .btn{height:40px;padding:0 14px;font-size:13px}
  .dock-msg{order:3;flex-basis:100%;min-width:0;font-size:12.5px}
  .dock-space{height:120px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}

.tile-meta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px}
.tile-time{font-size:10.5px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.tile-metrics{display:flex;gap:10px;font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;margin:0 auto 0 8px}
.catalyst-box{display:flex;flex-direction:column;gap:5px;margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid var(--line)}
.catalyst-text{font-size:11.5px;line-height:1.35;color:var(--ink)}
.conv{align-self:flex-start;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:99px;background:rgba(0,229,255,.14);color:var(--cyan)}
.conv-high{background:rgba(255,138,61,.2);color:var(--violet)}
.tgt-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px;margin-top:8px}
.tgt{display:flex;justify-content:space-between;gap:6px;font-size:12px;font-variant-numeric:tabular-nums}
.tgt-l{color:var(--muted)}
.hold-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;padding-top:9px;border-top:1px solid var(--line);font-size:12px}
.hold-btns{display:flex;gap:6px}
.tbtn{font:inherit;font-size:11.5px;font-weight:700;padding:5px 9px;border-radius:8px;border:1px solid var(--line2);background:var(--raised);color:var(--ink);cursor:pointer}
.tbtn-buy{color:var(--up);border-color:rgba(0,245,160,.4)}
.tbtn-sell{color:var(--down);border-color:rgba(255,77,125,.4)}
.tbtn:disabled{opacity:.35;cursor:not-allowed}
.tbtn:hover:not(:disabled){filter:brightness(1.25)}

.tile-head{display:flex;align-items:center;gap:10px;min-width:0}
.tile-id{display:flex;flex-direction:column;min-width:0;flex:1}
.avatar{flex:none;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:12px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.35)}
.tile-rail{position:absolute;left:0;top:14px;bottom:14px;width:3px;border-radius:0 3px 3px 0;background:var(--faint)}
.tile-up .tile-rail{background:var(--up);box-shadow:0 0 12px var(--up)}
.tile-down .tile-rail{background:var(--down);box-shadow:0 0 12px var(--down)}
.pill{font-size:12px;font-weight:700;padding:3px 9px;border-radius:99px;white-space:nowrap}
.pill-up{background:rgba(0,245,160,.15);color:var(--up)}
.pill-down{background:rgba(255,77,125,.15);color:var(--down)}
.tile-range{margin-top:8px}
.tile-range-track{position:relative;display:block;height:4px;border-radius:4px;background:linear-gradient(90deg,var(--down),var(--amber),var(--up));opacity:.55}
.tile-range-dot{position:absolute;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px rgba(0,0,0,.4)}
.vchip-prelim{border:1px dashed currentColor}
.prelim-note{font-size:12px;color:var(--amber);margin:8px 0 0;line-height:1.4}
.panel-title{font-family:var(--display);font-size:14px;font-weight:600;margin:0 0 12px}
.sbars,.movers{list-style:none;margin:0;padding:0}
.sbar{all:unset;box-sizing:border-box;display:grid;grid-template-columns:96px minmax(0,1fr) 54px;align-items:center;gap:8px;width:100%;padding:5px 0;cursor:pointer;font-size:12px}
.sbar-name{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sbar-track{position:relative;height:8px;border-radius:6px;background:rgba(255,255,255,.05)}
.sbar-mid{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--line2)}
.sbar-fill{position:absolute;top:0;bottom:0;border-radius:6px}
.sbar-up{background:var(--up)}.sbar-down{background:var(--down)}
.sbar-val{text-align:right;font-weight:600}

.tile-time-stale{color:var(--amber)}
.conv-bad{background:rgba(255,77,125,.18);color:var(--down)}
.paper-tag{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 6px;border-radius:6px;border:1px dashed var(--faint);color:var(--muted);vertical-align:middle;margin-right:2px}
.mtile-sub{display:block;font-size:10.5px;color:var(--muted);margin-top:2px}
.sizing-break,.health{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:6px}
.sizing-break li,.health li{display:flex;justify-content:space-between;gap:10px;font-size:12.5px}
.sizing-break li span,.health li span{color:var(--muted)}
.hl-ok{color:var(--up)}.hl-warn{color:var(--amber)}.hl-bad{color:var(--down)}
.news{margin-top:18px}
.news-list{list-style:none;margin:8px 0;padding:0;display:grid;gap:10px}
.news-list li{display:flex;flex-direction:column;gap:2px}
.news-list a{color:var(--ink);text-decoration:none;font-size:13px;line-height:1.35}
.news-list a:hover{color:var(--cyan);text-decoration:underline}
.tr-table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}
.tr-table th{text-align:left;font-weight:600;color:var(--muted);padding:4px 4px 4px 0;border-bottom:1px solid var(--line)}
.tr-table td{padding:5px 4px 5px 0;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
.tr-verdict{font-size:12.5px;line-height:1.45;margin:0 0 8px;padding:8px 10px;border-radius:10px;border:1px solid var(--line2)}
.tr-edge{background:rgba(0,245,160,.08)}.tr-negative{background:rgba(255,77,125,.1)}.tr-none,.tr-pending{background:rgba(255,225,77,.07)}
.journal{margin-top:20px}
.backup-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:16px}
.site-foot{max-width:1920px;margin:8px auto 90px;padding:0 24px;font-size:11.5px;line-height:1.5;color:var(--faint)}
`;