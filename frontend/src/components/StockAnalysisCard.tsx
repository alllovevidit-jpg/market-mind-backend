import React, { useState } from 'react';

interface AnalysisData {
  ticker: string;
  status: string;
  timestamp: string;
  market_data: {
    current_price: number;
    sma_50: number;
    sma_200: number;
    daily_volatility: number;
    annualized_volatility: number;
  };
  sentiment_analysis: {
    sentiment_score: number;
    catalyst_detected: string;
    risk_flag: boolean;
  };
  trajectory_outlook: string;
  risk_management: {
    recommended_entry: number;
    stop_loss: number;
    stop_loss_percentage: number;
    take_profit: number;
    quantity_purchase: number;
    max_capital_at_risk: number;
  };
}

export const StockAnalysisCard: React.FC = () => {
  const [ticker, setTicker] = useState('AAPL');
  const [accountSize, setAccountSize] = useState(10000);
  const [data, setData] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`http://127.0.0.1:8002/api/analysis/${ticker}?account_size=${accountSize}`);
      if (!response.ok) throw new Error('Failed to fetch institutional analysis');
      const result = await response.json();
      setData(result);
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto bg-gray-900 text-white rounded-xl shadow-2xl border border-gray-800">
      <h2 className="text-xl font-bold mb-4 text-emerald-400">Market-Mind Institutional Analyzer</h2>
      
      <form onSubmit={fetchAnalysis} className="flex gap-4 mb-6">
        <input
          type="text"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="Ticker (e.g., AAPL)"
          className="bg-gray-800 border border-gray-700 px-4 py-2 rounded-lg uppercase font-semibold focus:outline-none focus:border-emerald-500"
        />
        <input
          type="number"
          value={accountSize}
          onChange={(e) => setAccountSize(Number(e.target.value))}
          placeholder="Account Size ($)"
          className="bg-gray-800 border border-gray-700 px-4 py-2 rounded-lg focus:outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-emerald-600 hover:bg-emerald-500 px-6 py-2 rounded-lg font-bold transition-all disabled:opacity-50"
        >
          {loading ? 'Analyzing...' : 'Run Analysis'}
        </button>
      </form>

      {error && <div className="p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200 mb-4">{error}</div>}

      {data && (
        <div className="space-y-4">
          <div className="flex justify-between items-center bg-gray-800/60 p-4 rounded-lg border border-gray-700">
            <div>
              <span className="text-xs text-gray-400 uppercase tracking-wider">Asset</span>
              <h3 className="text-2xl font-black text-white">{data.ticker}</h3>
            </div>
            <div className="text-right">
              <span className="text-xs text-gray-400 uppercase tracking-wider">Current Price</span>
              <p className="text-xl font-bold text-emerald-400">${data.market_data.current_price.toFixed(2)}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-800/60 p-4 rounded-lg border border-gray-700">
              <span className="text-xs text-gray-400 uppercase tracking-wider">Trajectory Outlook</span>
              <p className="text-md font-semibold text-cyan-400 mt-1">{data.trajectory_outlook}</p>
            </div>
            <div className="bg-gray-800/60 p-4 rounded-lg border border-gray-700">
              <span className="text-xs text-gray-400 uppercase tracking-wider">Quantity to Purchase</span>
              <p className="text-md font-semibold text-emerald-400 mt-1">{data.risk_management.quantity_purchase} Shares</p>
            </div>
          </div>

          <div className="bg-gray-800/60 p-4 rounded-lg border border-gray-700 grid grid-cols-3 gap-2 text-center">
            <div>
              <span className="text-xs text-gray-400 block">Stop Loss</span>
              <span className="text-red-400 font-bold">${data.risk_management.stop_loss}</span>
            </div>
            <div>
              <span className="text-xs text-gray-400 block">Take Profit</span>
              <span className="text-emerald-400 font-bold">${data.risk_management.take_profit}</span>
            </div>
            <div>
              <span className="text-xs text-gray-400 block">Risk at Stake</span>
              <span className="text-amber-400 font-bold">${data.risk_management.max_capital_at_risk}</span>
            </div>
          </div>

          <div className="bg-gray-800/40 p-4 rounded-lg border border-gray-800 text-xs text-gray-400">
            <strong className="text-gray-300 block mb-1">Catalyst Detected:</strong>
            {data.sentiment_analysis.catalyst_detected}
          </div>
        </div>
      )}
    </div>
  );
};