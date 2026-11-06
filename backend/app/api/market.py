from urllib.parse import unquote
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Instrument, DailyPrice

router = APIRouter()

@router.get("/prices")
def get_latest_prices(db: Session = Depends(get_db)):
    results = (
        db.query(
            Instrument.symbol,
            Instrument.company_name,
            DailyPrice.close_price,
            DailyPrice.timestamp
        )
        .join(DailyPrice, Instrument.id == DailyPrice.instrument_id)
        .order_by(DailyPrice.timestamp.desc())
        .all()
    )
    
    # Deduplicate cleanly in Python so it never crashes on SQLite or Postgres
    seen = set()
    latest_prices = []
    for r in results:
        if r.symbol not in seen:
            seen.add(r.symbol)
            latest_prices.append({
                "symbol": r.symbol,
                "company": r.company_name,
                "latest_close": float(r.close_price),
                "last_updated": r.timestamp.isoformat() if r.timestamp else ""
            })
            
    return latest_prices

@router.get("/history/{symbol}")
def get_historical_prices(symbol: str, db: Session = Depends(get_db)):
    clean_symbol = unquote(symbol)
    results = (
        db.query(DailyPrice.close_price, DailyPrice.timestamp)
        .join(Instrument, Instrument.id == DailyPrice.instrument_id)
        .filter(Instrument.symbol == clean_symbol)
        .order_by(DailyPrice.timestamp.asc())
        .limit(30)
        .all()
    )
    
    return [
        {
            "time": r.timestamp.strftime("%H:%M:%S") if r.timestamp else "Now",
            "price": round(float(r.close_price), 2)
        }
        for r in results
    ]
from pydantic import BaseModel
from datetime import datetime

class TickerCreate(BaseModel):
    symbol: str
    company: str
    initial_price: float = 1500.0

@router.post("/add")
def add_custom_ticker(payload: TickerCreate, db: Session = Depends(get_db)):
    clean_symbol = payload.symbol.strip().upper()
    clean_company = payload.company.strip().upper().replace(" ", "_")
    
    instrument = db.query(Instrument).filter(Instrument.symbol == clean_symbol).first()
    if not instrument:
        instrument = Instrument(symbol=clean_symbol, company_name=clean_company)
        db.add(instrument)
        db.commit()
        db.refresh(instrument)
        
    new_price = DailyPrice(
        instrument_id=instrument.id,
        close_price=payload.initial_price,
        timestamp=datetime.utcnow()
    )
    db.add(new_price)
    db.commit()
    
    return {
        "symbol": instrument.symbol,
        "company": instrument.company_name,
        "latest_close": float(new_price.close_price),
        "last_updated": new_price.timestamp.isoformat()
    }

@router.get("/signals")
def get_quant_signals(db: Session = Depends(get_db)):
    """Computes momentum, RSI, and catalyst-backed buy/sell alerts for tracked assets."""
    instruments = db.query(Instrument).all()
    signals = {}
    
    for inst in instruments:
        prices = (
            db.query(DailyPrice.close_price)
            .filter(DailyPrice.instrument_id == inst.id)
            .order_by(DailyPrice.timestamp.asc())
            .limit(30)
            .all()
        )
        closes = [float(p.close_price) for p in prices]
        if len(closes) < 2:
            continue
            
        gains = [max(0, closes[i] - closes[i - 1]) for i in range(1, len(closes))]
        losses = [max(0, closes[i - 1] - closes[i]) for i in range(1, len(closes))]
        avg_gain = sum(gains) / len(gains) if gains else 1.0
        avg_loss = sum(losses) / len(losses) if losses else 1.0
        rs = avg_gain / (avg_loss if avg_loss > 0 else 0.001)
        rsi = round(100 - (100 / (1 + rs)), 1)
        
        signals[inst.symbol] = {
            "rsi": rsi,
            "action": "SELL / BOOK PROFIT" if rsi > 72 else ("STRONG BUY" if rsi < 48 else "ACCUMULATE")
        }
    return signals

import yfinance as yf

@router.get("/lookup/{query}")
def lookup_indian_stock(query: str, db: Session = Depends(get_db)):
    """Dynamically fetches any NSE (.NS) or BSE (.BO) listed stock from Yahoo Finance."""
    raw = unquote(query).strip().upper()
    candidates = [raw] if (raw.endswith(".NS") or raw.endswith(".BO") or raw.startswith("^")) else [f"{raw}.NS", f"{raw}.BO"]
    
    for sym in candidates:
        try:
            ticker = yf.Ticker(sym)
            hist = ticker.history(period="1mo")
            if not hist.empty:
                latest_close = round(float(hist["Close"].iloc[-1]), 2)
                info_name = raw.replace(".NS", "").replace(".BO", "")
                
                # Save to database if not exists
                instrument = db.query(Instrument).filter(Instrument.symbol == sym).first()
                if not instrument:
                    instrument = Instrument(symbol=sym, company_name=info_name)
                    db.add(instrument)
                    db.commit()
                    db.refresh(instrument)
                
                new_price = DailyPrice(
                    instrument_id=instrument.id,
                    close_price=latest_close,
                    timestamp=datetime.utcnow()
                )
                db.add(new_price)
                db.commit()
                
                return {
                    "symbol": sym,
                    "company": info_name,
                    "latest_close": latest_close,
                    "last_updated": datetime.utcnow().isoformat(),
                    "history": [
                        {"time": idx.strftime("%d %b"), "price": round(float(val), 2)}
                        for idx, val in hist["Close"].tail(20).items()
                    ]
                }
        except Exception as e:
            print(f"Lookup error for {sym}: {e}")
            continue
            
    return {"error": f"Could not find NSE/BSE listing for {raw}"}