import yfinance as yf
from datetime import datetime
from app.core.database import SessionLocal 
from app.models.instrument import Instrument
from app.models.price import DailyPrice

TICKERS = {
    "NIFTY_50": "^NSEI",
    "BSE_SENSEX": "^BSESN",
    "NIFTY_BANK": "^NSEBANK",
    "S&P_500": "^GSPC",
    "NASDAQ_100": "^NDX",
    "RELIANCE": "RELIANCE.NS",
    "HDFC_BANK": "HDFCBANK.NS"
}

def fetch_and_store_data():
    print("Starting MarketMind database ingestion...\n")
    db = SessionLocal()
    
    try:
        for name, symbol in TICKERS.items():
            print(f"Processing {name} ({symbol})...")
            
            instrument = db.query(Instrument).filter(Instrument.symbol == symbol).first()
            if not instrument:
                print(f"Creating new instrument record for {symbol}...")
                instrument = Instrument(
                    symbol=symbol,
                    company_name=name,
                    exchange="NSE" if symbol == "^NSEI" else "BSE",
                    is_active=True
                )
                db.add(instrument)
                db.commit()
                db.refresh(instrument)

            ticker = yf.Ticker(symbol)
            hist = ticker.history(period="1d")
            
            if hist.empty:
                print(f"No data found for {symbol}.\n")
                continue
                
            latest = hist.iloc[-1]
            
            new_price = DailyPrice(
                instrument_id=instrument.id,
                timestamp=datetime.now(),
                open_price=float(latest['Open']),
                high_price=float(latest['High']),
                low_price=float(latest['Low']),
                close_price=float(latest['Close']),
                volume=int(latest['Volume'])
            )
            
            db.add(new_price)
            db.commit()
            print(f"Successfully saved {name} data to PostgreSQL.\n")
            
    except Exception as e:
        print(f"Error during ingestion: {e}")
        db.rollback()
    finally:
        db.close()
        print("Ingestion complete. Database connection closed.")

if __name__ == "__main__":
    fetch_and_store_data()