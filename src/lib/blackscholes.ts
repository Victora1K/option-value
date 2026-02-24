// Cumulative standard normal distribution
function cdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y =
    1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

// Standard normal PDF
function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface OptionGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface OptionPriceResult {
  price: number;
  intrinsic: number;
  extrinsic: number;
  greeks: OptionGreeks;
}

export interface OptionParams {
  spotPrice: number;
  strikePrice: number;
  timeToExpiry: number; // in years
  riskFreeRate: number;
  impliedVolatility: number;
  optionType: "call" | "put";
}

export function blackScholesPrice(params: OptionParams): OptionPriceResult {
  const { spotPrice, strikePrice, timeToExpiry, riskFreeRate, impliedVolatility, optionType } = params;

  // Handle edge case: at or very near expiry
  const T = Math.max(timeToExpiry, 1e-10);
  const S = spotPrice;
  const K = strikePrice;
  const r = riskFreeRate;
  const sigma = impliedVolatility;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  let price: number;
  let delta: number;

  if (optionType === "call") {
    price = S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
    delta = cdf(d1);
  } else {
    price = K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
    delta = cdf(d1) - 1;
  }

  const gamma = pdf(d1) / (S * sigma * sqrtT);
  const vega = S * pdf(d1) * sqrtT / 100; // per 1% move in IV
  const theta =
    optionType === "call"
      ? (-(S * pdf(d1) * sigma) / (2 * sqrtT) - r * K * Math.exp(-r * T) * cdf(d2)) / 365
      : (-(S * pdf(d1) * sigma) / (2 * sqrtT) + r * K * Math.exp(-r * T) * cdf(-d2)) / 365;
  const rho =
    optionType === "call"
      ? (K * T * Math.exp(-r * T) * cdf(d2)) / 100
      : (-K * T * Math.exp(-r * T) * cdf(-d2)) / 100;

  const intrinsic =
    optionType === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const extrinsic = Math.max(price - intrinsic, 0);

  return {
    price: Math.max(price, 0),
    intrinsic,
    extrinsic,
    greeks: { delta, gamma, theta, vega, rho },
  };
}

export interface PnLPoint {
  stockPrice: number;
  optionValue: number;
  intrinsicValue: number;
  pnl: number;
  pnlPercent: number;
}

export function calculatePnLCurve(
  params: OptionParams,
  costBasis: number,
  rangeBelow: number = 5,
  rangeAbove: number = 5,
  steps: number = 200
): PnLPoint[] {
  const points: PnLPoint[] = [];
  const low = params.spotPrice - rangeBelow;
  const high = params.spotPrice + rangeAbove;
  const step = (high - low) / steps;

  for (let i = 0; i <= steps; i++) {
    const stockPrice = low + i * step;
    const result = blackScholesPrice({ ...params, spotPrice: stockPrice });
    const intrinsic =
      params.optionType === "call"
        ? Math.max(stockPrice - params.strikePrice, 0)
        : Math.max(params.strikePrice - stockPrice, 0);

    points.push({
      stockPrice: Math.round(stockPrice * 100) / 100,
      optionValue: Math.round(result.price * 100) / 100,
      intrinsicValue: Math.round(intrinsic * 100) / 100,
      pnl: Math.round((result.price - costBasis) * 100) / 100,
      pnlPercent:
        costBasis > 0
          ? Math.round(((result.price - costBasis) / costBasis) * 10000) / 100
          : 0,
    });
  }

  return points;
}

export interface TimePoint {
  time: string;       // "9:30 AM", "10:00 AM", etc.
  minutesSinceOpen: number;
  optionValue: number;
  intrinsicValue: number;
  pnl: number;
  pnlPercent: number;
  theta: number;
}

// Market open/close in minutes since midnight ET
const MARKET_OPEN_MINUTES = 9 * 60 + 30;   // 9:30 AM
const MARKET_CLOSE_MINUTES = 16 * 60;       // 4:00 PM
const TRADING_MINUTES = MARKET_CLOSE_MINUTES - MARKET_OPEN_MINUTES; // 390

function minutesToLabel(minutesSinceMidnight: number): string {
  const h = Math.floor(minutesSinceMidnight / 60);
  const m = minutesSinceMidnight % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

export function calculateTimeCurve(
  params: OptionParams,
  costBasis: number,
  fixedSpotPrice: number,
  intervalMinutes: number = 5
): TimePoint[] {
  const points: TimePoint[] = [];

  for (
    let elapsed = 0;
    elapsed <= TRADING_MINUTES;
    elapsed += intervalMinutes
  ) {
    const absoluteMinute = MARKET_OPEN_MINUTES + elapsed;
    const remainingMinutes = TRADING_MINUTES - elapsed;
    // Remaining time as fraction of a year
    const tteYears = Math.max(remainingMinutes / (365 * 24 * 60), 1e-10);

    const result = blackScholesPrice({
      ...params,
      spotPrice: fixedSpotPrice,
      timeToExpiry: tteYears,
    });

    const intrinsic =
      params.optionType === "call"
        ? Math.max(fixedSpotPrice - params.strikePrice, 0)
        : Math.max(params.strikePrice - fixedSpotPrice, 0);

    points.push({
      time: minutesToLabel(absoluteMinute),
      minutesSinceOpen: elapsed,
      optionValue: Math.round(result.price * 100) / 100,
      intrinsicValue: Math.round(intrinsic * 100) / 100,
      pnl: Math.round((result.price - costBasis) * 100) / 100,
      pnlPercent:
        costBasis > 0
          ? Math.round(((result.price - costBasis) / costBasis) * 10000) / 100
          : 0,
      theta: Math.round(result.greeks.theta * 10000) / 10000,
    });
  }

  return points;
}

// Calculate option value using greeks approximation (Taylor expansion)
export function greeksApproxValue(
  currentPrice: number,
  newSpotPrice: number,
  delta: number,
  gamma: number,
  theta: number,
  timeDecayHours: number = 0
): number {
  const dS = newSpotPrice - currentPrice; // change in underlying
  const deltaEffect = delta * dS;
  const gammaEffect = 0.5 * gamma * dS * dS;
  const thetaEffect = theta * (timeDecayHours / 24); // theta is per day

  return currentPrice + deltaEffect + gammaEffect + thetaEffect;
}
