"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Calculator, TrendingUp, Download, RefreshCw, Copy, Check } from "lucide-react";
import { calculatePnLCurve, calculateTimeCurve, blackScholesPrice } from "../lib/blackscholes";
import type { PnLPoint, TimePoint } from "../lib/blackscholes";

interface OptionContract {
  ticker: string;
  strikePrice: number;
  optionType: string;
  expirationDate: string;
  lastPrice: number;
  bid: number;
  ask: number;
  midpoint: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

const DONATION_ADDRESS = "0x73B61c903Cab90D5C251E58FEa6D90cC3d006a68";

function getETTimeParts(): { h: number; m: number; s: number; dow: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === "hour")!.value);
  const m = parseInt(parts.find(p => p.type === "minute")!.value);
  const s = parseInt(parts.find(p => p.type === "second")!.value);
  const weekday = parts.find(p => p.type === "weekday")!.value; // e.g. "Mon"
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[weekday] ?? new Date().getDay();
  return { h, m, s, dow };
}

// Returns true if NYSE is currently in a trading session (Mon-Fri, 9:30-16:00 ET)
function isMarketOpen(): boolean {
  const { h, m, dow } = getETTimeParts();
  if (dow === 0 || dow === 6) return false;
  const etMinutes = h * 60 + m;
  return etMinutes >= 9 * 60 + 30 && etMinutes < 16 * 60;
}

// Hours remaining in today's session (0 if market closed/after hours)
function hoursLeftToday(): number {
  const { h, m, s, dow } = getETTimeParts();
  if (dow === 0 || dow === 6) return 0;
  const etMinutes = h * 60 + m + s / 60;
  const closeMinutes = 16 * 60;
  if (etMinutes < 9 * 60 + 30) {
    // Pre-market: full session remaining
    return 6.5;
  }
  const diff = closeMinutes - etMinutes;
  return diff > 0 ? Math.min(diff / 60, 6.5) : 0;
}

// Compute TTE in hours for a given DTE
// 0 DTE: remaining hours today (capped to 6.5)
// 1 DTE: remaining today (if open) + full 6.5h tomorrow session
function hoursUntilExpiry(dte: 0 | 1): number {
  if (dte === 0) {
    return hoursLeftToday();
  }
  // 1 DTE: next trading day is a full 6.5h session
  const todayHours = isMarketOpen() ? hoursLeftToday() : 0;
  return todayHours + 6.5;
}

export default function Home() {
  // Manual input state
  const [optionType, setOptionType] = useState<"call" | "put">("call");
  const [spotPrice, setSpotPrice] = useState<string>("590");
  const [strikePrice, setStrikePrice] = useState<string>("590");
  const [costBasis, setCostBasis] = useState<string>("1.50");
  const [iv, setIv] = useState<string>("25");
  const [timeToExpiry, setTimeToExpiry] = useState<string>(() => hoursUntilExpiry(0).toFixed(2));
  const [riskFreeRate] = useState<string>("5.25");
  const [rangeBelow, setRangeBelow] = useState<string>("5");
  const [rangeAbove, setRangeAbove] = useState<string>("5");
  const [timeToHold, setTimeToHold] = useState<string>("1");
  const [copied, setCopied] = useState(false);

  // Polygon.io state
  const [ticker, setTicker] = useState<string>("SPY");
  const [dte, setDte] = useState<0 | 1>(0);
  const [loadingChain, setLoadingChain] = useState(false);
  const [chainError, setChainError] = useState<string>("");
  const [optionChain, setOptionChain] = useState<OptionContract[]>([]);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [selectedContract, setSelectedContract] = useState<OptionContract | null>(null);

  // Refs for ATM scroll
  const callsContainerRef = useRef<HTMLDivElement>(null);
  const putsContainerRef = useRef<HTMLDivElement>(null);
  const atmCallRef = useRef<HTMLTableRowElement>(null);
  const atmPutRef = useRef<HTMLTableRowElement>(null);

  // Chart tab state
  const [activeTab, setActiveTab] = useState<"price" | "time">("price");

  // Time chart state
  const [timeChartData, setTimeChartData] = useState<TimePoint[]>([]);
  const [timeChartSpot, setTimeChartSpot] = useState<string>("");

  // Chart data
  const [chartData, setChartData] = useState<PnLPoint[]>([]);
  const [currentCalc, setCurrentCalc] = useState<{
    price: number;
    intrinsic: number;
    extrinsic: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  } | null>(null);

  const calculateChart = useCallback(() => {
    const spot = parseFloat(spotPrice);
    const strike = parseFloat(strikePrice);
    const cost = parseFloat(costBasis);
    const ivVal = parseFloat(iv) / 100;
    const tte = parseFloat(timeToExpiry) / 24; // convert hours to days, then to years
    const tteYears = tte / 365;
    const rfr = parseFloat(riskFreeRate) / 100;
    const rBelow = parseFloat(rangeBelow);
    const rAbove = parseFloat(rangeAbove);

    if (isNaN(spot) || isNaN(strike) || isNaN(cost) || isNaN(ivVal) || isNaN(tte)) {
      return;
    }

    const params = {
      spotPrice: spot,
      strikePrice: strike,
      timeToExpiry: tteYears,
      riskFreeRate: rfr,
      impliedVolatility: ivVal,
      optionType,
    };

    const data = calculatePnLCurve(params, cost, rBelow, rAbove, 200);
    setChartData(data);

    const current = blackScholesPrice(params);
    setCurrentCalc({
      price: current.price,
      intrinsic: current.intrinsic,
      extrinsic: current.extrinsic,
      delta: current.greeks.delta,
      gamma: current.greeks.gamma,
      theta: current.greeks.theta,
      vega: current.greeks.vega,
    });
  }, [spotPrice, strikePrice, costBasis, iv, timeToExpiry, riskFreeRate, optionType, rangeBelow, rangeAbove]);

  // Dropdown options: spot ± $5 in $0.50 steps
  const spotPriceOptions = useMemo(() => {
    const spot = parseFloat(spotPrice);
    if (isNaN(spot)) return [];
    const options: number[] = [];
    for (let p = spot - 5; p <= spot + 5 + 0.001; p += 0.5) {
      options.push(Math.round(p * 100) / 100);
    }
    return options;
  }, [spotPrice]);

  const calculateTimeChart = useCallback((fixedSpot: number) => {
    const strike = parseFloat(strikePrice);
    const cost = parseFloat(costBasis);
    const ivVal = parseFloat(iv) / 100;
    const rfr = parseFloat(riskFreeRate) / 100;
    if (isNaN(strike) || isNaN(cost) || isNaN(ivVal) || isNaN(fixedSpot)) return;

    const params = {
      spotPrice: fixedSpot,
      strikePrice: strike,
      timeToExpiry: 390 / (365 * 24 * 60), // full day TTE as starting point (unused — curve iterates internally)
      riskFreeRate: rfr,
      impliedVolatility: ivVal,
      optionType,
    };

    const data = calculateTimeCurve(params, cost, fixedSpot, 5);
    setTimeChartData(data);
  }, [strikePrice, costBasis, iv, riskFreeRate, optionType]);

  const handleTimeSpotChange = useCallback((val: string) => {
    setTimeChartSpot(val);
    calculateTimeChart(parseFloat(val));
  }, [calculateTimeChart]);

  const fetchOptionChain = useCallback(async () => {
    setLoadingChain(true);
    setChainError("");
    setOptionChain([]);
    setSelectedContract(null);

    try {
      const res = await fetch(`/api/options?ticker=${encodeURIComponent(ticker)}&dte=${dte}`);
      const data = await res.json();

      if (!res.ok) {
        setChainError(data.error || "Failed to fetch option chain");
        if (data.currentPrice) setLivePrice(data.currentPrice);
        return;
      }

      setLivePrice(data.currentPrice);
      setOptionChain(data.options);
      setSpotPrice(data.currentPrice.toString());
    } catch {
      setChainError("Network error fetching option chain");
    } finally {
      setLoadingChain(false);
    }
  }, [ticker, dte]);

  const selectContract = useCallback(
    (contract: OptionContract) => {
      setSelectedContract(contract);
      setStrikePrice(contract.strikePrice.toString());
      setOptionType(contract.optionType as "call" | "put");
      setCostBasis(
        (contract.midpoint || contract.lastPrice || ((contract.bid + contract.ask) / 2)).toFixed(2)
      );
      if (contract.impliedVolatility > 0) {
        setIv((contract.impliedVolatility * 100).toFixed(1));
      }
      // Auto-populate time to expiry from current ET clock
      setTimeToExpiry(hoursUntilExpiry(dte).toFixed(2));
    },
    [dte]
  );

  const handleCopyDonation = useCallback(() => {
    navigator.clipboard.writeText(DONATION_ADDRESS).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const calls = useMemo(
    () => optionChain.filter((o) => o.optionType === "call"),
    [optionChain]
  );
  const puts = useMemo(
    () => optionChain.filter((o) => o.optionType === "put"),
    [optionChain]
  );

  // Index of the ATM row in each sorted list (closest strike to livePrice)
  const atmCallIdx = useMemo(() => {
    if (!livePrice || calls.length === 0) return -1;
    let best = 0;
    let bestDiff = Math.abs(calls[0].strikePrice - livePrice);
    for (let i = 1; i < calls.length; i++) {
      const d = Math.abs(calls[i].strikePrice - livePrice);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return best;
  }, [calls, livePrice]);

  const atmPutIdx = useMemo(() => {
    if (!livePrice || puts.length === 0) return -1;
    let best = 0;
    let bestDiff = Math.abs(puts[0].strikePrice - livePrice);
    for (let i = 1; i < puts.length; i++) {
      const d = Math.abs(puts[i].strikePrice - livePrice);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return best;
  }, [puts, livePrice]);

  // Scroll ATM row into center of the table container after chain loads
  useEffect(() => {
    if (atmCallRef.current && callsContainerRef.current) {
      const container = callsContainerRef.current;
      const row = atmCallRef.current;
      container.scrollTop = row.offsetTop - container.clientHeight / 2 + row.clientHeight / 2;
    }
  }, [atmCallIdx]);

  useEffect(() => {
    if (atmPutRef.current && putsContainerRef.current) {
      const container = putsContainerRef.current;
      const row = atmPutRef.current;
      container.scrollTop = row.offsetTop - container.clientHeight / 2 + row.clientHeight / 2;
    }
  }, [atmPutIdx]);

  const breakeven = useMemo(() => {
    const strike = parseFloat(strikePrice);
    const cost = parseFloat(costBasis);
    if (isNaN(strike) || isNaN(cost)) return null;
    return optionType === "call" ? strike + cost : strike - cost;
  }, [strikePrice, costBasis, optionType]);

  // Time-to-hold vertical line: find minutesSinceOpen for the hold time
  const holdLineTime = useMemo(() => {
    const tte = parseFloat(timeToExpiry);
    const hold = parseFloat(timeToHold);
    if (isNaN(tte) || isNaN(hold)) return null;
    const remainingAfterHold = tte - hold;
    if (remainingAfterHold < 0) return null;
    // trading minutes elapsed = total trading minutes - remaining minutes
    const totalTradingHrs = 6.5;
    const elapsedHrs = totalTradingHrs - tte + hold;
    const elapsedMins = Math.round(elapsedHrs * 60);
    if (elapsedMins < 0 || elapsedMins > 390) return null;
    return elapsedMins;
  }, [timeToExpiry, timeToHold]);

  // P&L table recalculated at hold-time TTE
  const holdChartData = useMemo(() => {
    const spot = parseFloat(spotPrice);
    const strike = parseFloat(strikePrice);
    const cost = parseFloat(costBasis);
    const ivVal = parseFloat(iv) / 100;
    const tte = parseFloat(timeToExpiry);
    const hold = parseFloat(timeToHold);
    const rfr = parseFloat(riskFreeRate) / 100;
    const rBelow = parseFloat(rangeBelow);
    const rAbove = parseFloat(rangeAbove);
    if (isNaN(spot) || isNaN(strike) || isNaN(cost) || isNaN(ivVal) || isNaN(tte) || isNaN(hold)) return null;
    const remainingHrs = Math.max(tte - hold, 0);
    const tteYears = (remainingHrs / 24) / 365;
    const params = { spotPrice: spot, strikePrice: strike, timeToExpiry: tteYears, riskFreeRate: rfr, impliedVolatility: ivVal, optionType };
    return calculatePnLCurve(params, cost, rBelow, rAbove, 200);
  }, [spotPrice, strikePrice, costBasis, iv, timeToExpiry, timeToHold, riskFreeRate, optionType, rangeBelow, rangeAbove]);

  // Find the time label for the hold line to use as ReferenceLine x value
  const holdLineLabel = useMemo(() => {
    if (holdLineTime === null || timeChartData.length === 0) return null;
    const point = timeChartData.find(p => p.minutesSinceOpen >= holdLineTime);
    return point?.time ?? null;
  }, [holdLineTime, timeChartData]);

  return (
    <div className="min-h-screen bg-[#0f1117] text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-[#0f1117]/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <Calculator className="w-6 h-6 text-emerald-400 shrink-0" />
          <h1 className="text-xl font-bold tracking-tight">0DTE Option Value Calculator</h1>
          <span className="text-[10px] text-yellow-600 bg-yellow-950/40 border border-yellow-900/50 rounded px-2 py-0.5">
            Educational purposes only — not financial advice
          </span>
          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={handleCopyDonation}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-emerald-400 transition-colors border border-gray-700 hover:border-emerald-700 rounded-lg px-3 py-1.5"
              title={DONATION_ADDRESS}
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              {copied ? "Copied!" : "Support / Donate"}
            </button>
            <span className="text-xs text-gray-500">Black-Scholes Model</span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Polygon.io Data Fetch */}
        <section className="bg-[#1a1d27] rounded-xl border border-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <Download className="w-4 h-4" />
            Live Option Chain (Polygon.io)
          </h2>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Ticker</label>
              <input
                type="text"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                className="bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm w-24 focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>
            {/* DTE toggle */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Expiry</label>
              <div className="flex rounded-lg overflow-hidden border border-gray-700">
                <button
                  onClick={() => setDte(0)}
                  className={`px-3 py-2 text-xs font-medium transition-colors ${
                    dte === 0 ? "bg-emerald-700 text-white" : "bg-[#0f1117] text-gray-400 hover:text-white"
                  }`}
                >
                  0 DTE
                </button>
                <button
                  onClick={() => setDte(1)}
                  className={`px-3 py-2 text-xs font-medium transition-colors ${
                    dte === 1 ? "bg-blue-700 text-white" : "bg-[#0f1117] text-gray-400 hover:text-white"
                  }`}
                >
                  1 DTE
                </button>
              </div>
            </div>
            <button
              onClick={fetchOptionChain}
              disabled={loadingChain}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${loadingChain ? "animate-spin" : ""}`} />
              {loadingChain ? "Loading..." : `Fetch ${dte}DTE Chain`}
            </button>
            {livePrice && (
              <span className="text-sm text-emerald-400 font-mono">
                {ticker}: ${livePrice.toFixed(2)}
              </span>
            )}
          </div>
          {chainError && (
            <p className="mt-3 text-sm text-red-400">{chainError}</p>
          )}

          {/* Option Chain Table */}
          {optionChain.length > 0 && (
            <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Calls */}
              <div>
                <h3 className="text-xs font-semibold text-emerald-400 uppercase mb-2">
                  Calls ({calls.length})
                </h3>
                <div ref={callsContainerRef} className="max-h-64 overflow-y-auto rounded-lg border border-gray-700">
                  <table className="w-full text-xs">
                    <thead className="bg-[#0f1117] sticky top-0">
                      <tr className="text-gray-500">
                        <th className="px-2 py-1 text-left">Strike</th>
                        <th className="px-2 py-1 text-right">Bid</th>
                        <th className="px-2 py-1 text-right">Ask</th>
                        <th className="px-2 py-1 text-right">IV</th>
                        <th className="px-2 py-1 text-right">Delta</th>
                        <th className="px-2 py-1 text-right">Gamma</th>
                        <th className="px-2 py-1 text-right">Vol</th>
                        <th className="px-2 py-1 text-right">Vega</th>
                        <th className="px-2 py-1 text-right">Theta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {calls.map((c, i) => (
                        <tr
                          key={c.ticker}
                          ref={i === atmCallIdx ? atmCallRef : undefined}
                          onClick={() => selectContract(c)}
                          className={`cursor-pointer hover:bg-emerald-900/30 transition-colors ${
                            selectedContract?.ticker === c.ticker
                              ? "bg-emerald-900/50"
                              : i === atmCallIdx
                              ? "bg-emerald-950/40 ring-1 ring-inset ring-emerald-700/50"
                              : ""
                          } ${
                            livePrice && c.strikePrice <= livePrice
                              ? "text-emerald-300"
                              : "text-gray-400"
                          }`}
                        >
                          <td className="px-2 py-1 font-mono">
                            {c.strikePrice}
                            {i === atmCallIdx && <span className="ml-1 text-[9px] text-emerald-500 font-bold">ATM</span>}
                          </td>
                          <td className="px-2 py-1 text-right font-mono">{c.bid.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-mono">{c.ask.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-mono">{(c.impliedVolatility * 100).toFixed(0)}%</td>
                          <td className="px-2 py-1 text-right font-mono">{c.delta.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-mono">{c.gamma.toFixed(4)}</td>
                          <td className="px-2 py-1 text-right font-mono">{c.volume}</td>
                          <td className="px-2 py-1 text-right font-mono">{c.vega.toFixed(4)}</td>
                          <td className="px-2 py-1 text-right font-mono text-red-400">{c.theta.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Puts */}
              <div>
                <h3 className="text-xs font-semibold text-red-400 uppercase mb-2">
                  Puts ({puts.length})
                </h3>
                <div ref={putsContainerRef} className="max-h-64 overflow-y-auto rounded-lg border border-gray-700">
                  <table className="w-full text-xs">
                    <thead className="bg-[#0f1117] sticky top-0">
                      <tr className="text-gray-500">
                        <th className="px-2 py-1 text-left">Strike</th>
                        <th className="px-2 py-1 text-right">Bid</th>
                        <th className="px-2 py-1 text-right">Ask</th>
                        <th className="px-2 py-1 text-right">IV</th>
                        <th className="px-2 py-1 text-right">Delta</th>
                        <th className="px-2 py-1 text-right">Gamma</th>
                        <th className="px-2 py-1 text-right">Vol</th>
                        <th className="px-2 py-1 text-right">Vega</th>
                        <th className="px-2 py-1 text-right">Theta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {puts.map((c, i) => (
                        <tr
                          key={c.ticker}
                          ref={i === atmPutIdx ? atmPutRef : undefined}
                          onClick={() => selectContract(c)}
                          className={`cursor-pointer hover:bg-red-900/30 transition-colors ${
                            selectedContract?.ticker === c.ticker
                              ? "bg-red-900/50"
                              : i === atmPutIdx
                              ? "bg-red-950/40 ring-1 ring-inset ring-red-700/50"
                              : ""
                          } ${
                            livePrice && c.strikePrice >= livePrice
                              ? "text-red-300"
                              : "text-gray-400"
                          }`}
                        >
                          <td className="px-2 py-1 font-mono">
                            {c.strikePrice}
                            {i === atmPutIdx && <span className="ml-1 text-[9px] text-red-500 font-bold">ATM</span>}
                          </td>
                          <td className="px-2 py-1 text-right font-mono">{c.bid.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-mono">{c.ask.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-mono">{(c.impliedVolatility * 100).toFixed(0)}%</td>
                          <td className="px-2 py-1 text-right font-mono">{c.delta.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-mono">{c.gamma.toFixed(4)}</td>
                          <td className="px-2 py-1 text-right font-mono">{c.volume}</td>
                          <td className="px-2 py-1 text-right font-mono">{c.vega.toFixed(4)}</td>
                          <td className="px-2 py-1 text-right font-mono text-red-400">{c.theta.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Calculator Inputs */}
        <section className="bg-[#1a1d27] rounded-xl border border-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Option Parameters
          </h2>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {/* Option Type Toggle */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Type</label>
              <div className="flex rounded-lg overflow-hidden border border-gray-700">
                <button
                  onClick={() => setOptionType("call")}
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${
                    optionType === "call"
                      ? "bg-emerald-600 text-white"
                      : "bg-[#0f1117] text-gray-400 hover:text-white"
                  }`}
                >
                  CALL
                </button>
                <button
                  onClick={() => setOptionType("put")}
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${
                    optionType === "put"
                      ? "bg-red-600 text-white"
                      : "bg-[#0f1117] text-gray-400 hover:text-white"
                  }`}
                >
                  PUT
                </button>
              </div>
            </div>

            <InputField label="Stock Price ($)" value={spotPrice} onChange={setSpotPrice} />
            <InputField label="Strike Price ($)" value={strikePrice} onChange={setStrikePrice} />
            <InputField label="Option Cost ($)" value={costBasis} onChange={setCostBasis} />
            <InputField label="IV (%)" value={iv} onChange={setIv} />
            <InputField label="Time to Expiry (hrs)" value={timeToExpiry} onChange={setTimeToExpiry} />
            <InputField label="Time to Hold (hrs)" value={timeToHold} onChange={setTimeToHold} />
            <InputField label="Risk-Free Rate (%)" value={riskFreeRate} onChange={() => {}} disabled />
            <InputField label="Range Below ($)" value={rangeBelow} onChange={setRangeBelow} />
            <InputField label="Range Above ($)" value={rangeAbove} onChange={setRangeAbove} />

            <div className="flex items-end">
              <button
                onClick={calculateChart}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                Calculate
              </button>
            </div>
          </div>

          {/* Current Calculation Summary */}
          {currentCalc && (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              <StatCard label="Theoretical Price" value={`$${currentCalc.price.toFixed(2)}`} />
              <StatCard label="Intrinsic" value={`$${currentCalc.intrinsic.toFixed(2)}`} />
              <StatCard label="Extrinsic" value={`$${currentCalc.extrinsic.toFixed(2)}`} />
              <StatCard
                label="Delta"
                value={currentCalc.delta.toFixed(4)}
                color={currentCalc.delta >= 0 ? "text-emerald-400" : "text-red-400"}
              />
              <StatCard label="Gamma" value={currentCalc.gamma.toFixed(4)} />
              <StatCard
                label="Theta"
                value={currentCalc.theta.toFixed(4)}
                color="text-red-400"
              />
              <StatCard label="Vega" value={currentCalc.vega.toFixed(4)} />
            </div>
          )}
        </section>

        {/* Tabbed Chart Section */}
        {(chartData.length > 0 || timeChartData.length > 0) && (
          <section className="bg-[#1a1d27] rounded-xl border border-gray-800 p-5">
            {/* Tab Bar */}
            <div className="flex items-center gap-1 mb-5 border-b border-gray-800 pb-0">
              <button
                onClick={() => setActiveTab("price")}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px ${
                  activeTab === "price"
                    ? "border-emerald-500 text-emerald-400 bg-emerald-950/30"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                Value vs Price
              </button>
              <button
                onClick={() => {
                  setActiveTab("time");
                  if (timeChartSpot === "" && spotPriceOptions.length > 0) {
                    const atm = spotPriceOptions.reduce((prev, cur) =>
                      Math.abs(cur - parseFloat(spotPrice)) < Math.abs(prev - parseFloat(spotPrice)) ? cur : prev
                    );
                    handleTimeSpotChange(atm.toString());
                  }
                }}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px ${
                  activeTab === "time"
                    ? "border-blue-500 text-blue-400 bg-blue-950/30"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                Value vs Time
              </button>
            </div>

            {/* Tab 1: Value vs Price */}
            {activeTab === "price" && chartData.length > 0 && (
              <>
                <div className="h-[500px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={chartData}
                      margin={{ top: 10, right: 30, left: 10, bottom: 10 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                      <XAxis
                        dataKey="stockPrice"
                        stroke="#6b7280"
                        fontSize={11}
                        tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                        label={{
                          value: "Stock Price",
                          position: "insideBottom",
                          offset: -5,
                          style: { fill: "#6b7280", fontSize: 12 },
                        }}
                      />
                      <YAxis
                        stroke="#6b7280"
                        fontSize={11}
                        tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                        label={{
                          value: "Option Value / P&L ($)",
                          angle: -90,
                          position: "insideLeft",
                          offset: 10,
                          style: { fill: "#6b7280", fontSize: 12 },
                        }}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#1a1d27",
                          border: "1px solid #374151",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                        formatter={(value: unknown, name: unknown) => [
                          `$${(value as number).toFixed(2)}`,
                          name as string,
                        ]}
                        labelFormatter={(label: unknown) => `Stock: $${(label as number).toFixed(2)}`}
                      />
                      <Legend />
                      <ReferenceLine
                        x={parseFloat(spotPrice)}
                        stroke="#6b7280"
                        strokeDasharray="5 5"
                        label={{
                          value: `Current: $${spotPrice}`,
                          position: "top",
                          style: { fill: "#9ca3af", fontSize: 10 },
                        }}
                      />
                      <ReferenceLine
                        x={parseFloat(strikePrice)}
                        stroke="#f59e0b"
                        strokeDasharray="5 5"
                        label={{
                          value: `Strike: $${strikePrice}`,
                          position: "top",
                          style: { fill: "#f59e0b", fontSize: 10 },
                        }}
                      />
                      {breakeven && (
                        <ReferenceLine
                          x={breakeven}
                          stroke="#ef4444"
                          strokeDasharray="3 3"
                          label={{
                            value: `BE: $${breakeven.toFixed(2)}`,
                            position: "top",
                            style: { fill: "#ef4444", fontSize: 10 },
                          }}
                        />
                      )}
                      <ReferenceLine y={parseFloat(costBasis)} stroke="#6366f1" strokeDasharray="3 3" />
                      <ReferenceLine y={0} stroke="#374151" />
                      <Line
                        type="monotone"
                        dataKey="optionValue"
                        name="Option Value"
                        stroke="#10b981"
                        strokeWidth={2.5}
                        dot={false}
                        activeDot={{ r: 4, fill: "#10b981" }}
                      />
                      <Line
                        type="monotone"
                        dataKey="intrinsicValue"
                        name="Intrinsic Value"
                        stroke="#f59e0b"
                        strokeWidth={1.5}
                        strokeDasharray="5 5"
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="pnl"
                        name="P&L"
                        stroke="#6366f1"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: "#6366f1" }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500">
                  <span><span className="inline-block w-3 h-0.5 bg-emerald-500 mr-1 align-middle" /> Option Value (Black-Scholes)</span>
                  <span><span className="inline-block w-3 h-0.5 bg-amber-500 mr-1 align-middle" /> Intrinsic Value</span>
                  <span><span className="inline-block w-3 h-0.5 bg-indigo-500 mr-1 align-middle" /> P&L (vs cost basis)</span>
                  {breakeven && <span className="text-red-400">Breakeven: ${breakeven.toFixed(2)}</span>}
                </div>
              </>
            )}

            {/* Tab 2: Value vs Time */}
            {activeTab === "time" && (
              <>
                {/* Stock price dropdown */}
                <div className="flex items-center gap-3 mb-4">
                  <label className="text-xs text-gray-500 whitespace-nowrap">Stock Price (fixed)</label>
                  <select
                    value={timeChartSpot}
                    onChange={(e) => handleTimeSpotChange(e.target.value)}
                    className="bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500 transition-colors"
                  >
                    {spotPriceOptions.length === 0 && (
                      <option value="">Enter stock price first</option>
                    )}
                    {spotPriceOptions.map((p) => (
                      <option key={p} value={p}>
                        ${p.toFixed(2)}{Math.abs(p - parseFloat(spotPrice)) < 0.001 ? " (ATM)" : p > parseFloat(spotPrice) ? ` (+$${(p - parseFloat(spotPrice)).toFixed(2)})` : ` (-$${(parseFloat(spotPrice) - p).toFixed(2)})`}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-gray-600">Shows theta decay from 9:30 AM → 4:00 PM ET assuming stock stays at this price</span>
                </div>

                {timeChartData.length > 0 ? (
                  <>
                    <div className="h-[500px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={timeChartData}
                          margin={{ top: 10, right: 30, left: 10, bottom: 30 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                          <XAxis
                            dataKey="time"
                            stroke="#6b7280"
                            fontSize={10}
                            interval={11}
                            label={{
                              value: "Time of Day (ET)",
                              position: "insideBottom",
                              offset: -15,
                              style: { fill: "#6b7280", fontSize: 12 },
                            }}
                          />
                          <YAxis
                            stroke="#6b7280"
                            fontSize={11}
                            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                            label={{
                              value: "Contract Price ($)",
                              angle: -90,
                              position: "insideLeft",
                              offset: 10,
                              style: { fill: "#6b7280", fontSize: 12 },
                            }}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "#1a1d27",
                              border: "1px solid #374151",
                              borderRadius: "8px",
                              fontSize: "12px",
                            }}
                            formatter={(value: unknown, name: unknown) => {
                              const v = value as number;
                              const n = name as string;
                              return [n === "P&L" ? `${v >= 0 ? "+" : ""}$${v.toFixed(2)}` : `$${v.toFixed(2)}`, n];
                            }}
                            labelFormatter={(label: unknown) => `Time: ${label as string}`}
                          />
                          <Legend />
                          <ReferenceLine
                            y={parseFloat(costBasis)}
                            stroke="#6366f1"
                            strokeDasharray="4 4"
                            label={{
                              value: `Cost: $${costBasis}`,
                              position: "right",
                              style: { fill: "#818cf8", fontSize: 10 },
                            }}
                          />
                          <ReferenceLine y={0} stroke="#374151" />
                          {holdLineLabel && (
                            <ReferenceLine
                              x={holdLineLabel}
                              stroke="#f97316"
                              strokeWidth={2}
                              strokeDasharray="6 3"
                              label={{
                                value: `Hold: ${timeToHold}h`,
                                position: "top",
                                style: { fill: "#f97316", fontSize: 10 },
                              }}
                            />
                          )}
                          <Line
                            type="monotone"
                            dataKey="optionValue"
                            name="Option Value"
                            stroke="#10b981"
                            strokeWidth={2.5}
                            dot={false}
                            activeDot={{ r: 4, fill: "#10b981" }}
                          />
                          <Line
                            type="monotone"
                            dataKey="intrinsicValue"
                            name="Intrinsic Value"
                            stroke="#f59e0b"
                            strokeWidth={1.5}
                            strokeDasharray="5 5"
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="pnl"
                            name="P&L"
                            stroke="#6366f1"
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4, fill: "#6366f1" }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500">
                      <span><span className="inline-block w-3 h-0.5 bg-emerald-500 mr-1 align-middle" /> Option Value (theta decay)</span>
                      <span><span className="inline-block w-3 h-0.5 bg-amber-500 mr-1 align-middle" /> Intrinsic Value (flat if stock fixed)</span>
                      <span><span className="inline-block w-3 h-0.5 bg-indigo-500 mr-1 align-middle" /> P&L (vs cost basis)</span>
                      <span className="text-blue-400">Fixed stock: ${parseFloat(timeChartSpot).toFixed(2)}</span>
                    </div>
                  </>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-gray-600 text-sm">
                    Select a stock price from the dropdown above
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {/* P&L Table */}
        {chartData.length > 0 && (
          <section className="bg-[#1a1d27] rounded-xl border border-gray-800 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                P&L Table — After {timeToHold}h Hold
              </h2>
              <span className="text-xs text-orange-400 border border-orange-900/50 bg-orange-950/30 rounded px-2 py-0.5">
                {parseFloat(timeToHold) >= parseFloat(timeToExpiry)
                  ? "At expiry (intrinsic only)"
                  : `${(parseFloat(timeToExpiry) - parseFloat(timeToHold)).toFixed(2)}h remaining at sell`}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-700">
                    <th className="px-3 py-2 text-left">Stock Price</th>
                    <th className="px-3 py-2 text-right">Option Value</th>
                    <th className="px-3 py-2 text-right">Intrinsic</th>
                    <th className="px-3 py-2 text-right">P&L ($)</th>
                    <th className="px-3 py-2 text-right">P&L (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {(holdChartData ?? chartData)
                    .filter((_, i) => i % 20 === 0 || i === chartData.length - 1)
                    .map((point, i) => (
                      <tr
                        key={i}
                        className="border-b border-gray-800 hover:bg-gray-800/50"
                      >
                        <td className="px-3 py-2 font-mono">${point.stockPrice.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right font-mono">${point.optionValue.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right font-mono">${point.intrinsicValue.toFixed(2)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${point.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {point.pnl >= 0 ? "+" : ""}${point.pnl.toFixed(2)}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono ${point.pnlPercent >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {point.pnlPercent >= 0 ? "+" : ""}{point.pnlPercent.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-500">{label}</label>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  color = "text-white",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bg-[#0f1117] rounded-lg border border-gray-800 p-3">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-mono font-semibold mt-1 ${color}`}>{value}</div>
    </div>
  );
}
