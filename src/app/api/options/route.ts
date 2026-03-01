import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const POLYGON_BASE = "https://api.polygon.io";

// Ticker must be 1-5 uppercase letters only
const TICKER_RE = /^[A-Z]{1,5}$/;

function getExpiryDate(dte: number): string {
  const d = new Date();
  // Use ET date (options expire by ET date)
  const etDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  const [month, day, year] = etDate.split("/");
  const base = new Date(`${year}-${month}-${day}T00:00:00`);
  base.setDate(base.getDate() + dte);
  // Skip weekends for 1 DTE: if Saturday -> Monday, if Sunday -> Monday
  const dow = base.getDay();
  if (dow === 6) base.setDate(base.getDate() + 2);
  else if (dow === 0) base.setDate(base.getDate() + 1);
  return base.toISOString().split("T")[0];
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const rawTicker = (searchParams.get("ticker") || "SPY").toUpperCase().trim();
  const dteParam = parseInt(searchParams.get("dte") || "0");
  const dte = dteParam === 1 ? 1 : 0;

  if (!TICKER_RE.test(rawTicker)) {
    return NextResponse.json({ error: "Invalid ticker symbol" }, { status: 400 });
  }
  const ticker = rawTicker;

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Polygon API key not configured on server. Set POLYGON_API_KEY env var." },
      { status: 500 }
    );
  }

  try {
    // Get current stock price
    const snapshotRes = await fetch(
      `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`,
      { cache: "no-store" }
    );

    if (!snapshotRes.ok) {
      const errText = await snapshotRes.text();
      return NextResponse.json(
        { error: `Failed to fetch stock data: ${errText}` },
        { status: snapshotRes.status }
      );
    }

    const snapshotData = await snapshotRes.json();
    const currentPrice =
      snapshotData?.ticker?.lastTrade?.p ||
      snapshotData?.ticker?.day?.c ||
      snapshotData?.ticker?.prevDay?.c;

    if (!currentPrice) {
      return NextResponse.json(
        { error: "Could not determine current stock price" },
        { status: 500 }
      );
    }

    // Get expiry date based on DTE
    const expDate = getExpiryDate(dte);

    // Fetch option contracts for the target expiry
    const contractsRes = await fetch(
      `${POLYGON_BASE}/v3/reference/options/contracts?underlying_ticker=${ticker}&expiration_date=${expDate}&limit=250&apiKey=${apiKey}`,
      { cache: "no-store" }
    );

    if (!contractsRes.ok) {
      const errText = await contractsRes.text();
      return NextResponse.json(
        { error: `Failed to fetch options contracts: ${errText}` },
        { status: contractsRes.status }
      );
    }

    const contractsData = await contractsRes.json();
    const contracts = contractsData.results || [];

    if (contracts.length === 0) {
      return NextResponse.json(
        {
          error: `No ${dte}DTE options found for ${ticker} expiring ${expDate}. Markets may be closed or no contracts listed yet.`,
          currentPrice,
        },
        { status: 404 }
      );
    }

    // Fetch snapshot for all option contracts to get greeks and pricing
    const optionsSnapshotRes = await fetch(
      `${POLYGON_BASE}/v3/snapshot/options/${ticker}?expiration_date=${expDate}&limit=250&apiKey=${apiKey}`,
      { cache: "no-store" }
    );

    let optionsWithGreeks: OptionContract[] = [];

    if (optionsSnapshotRes.ok) {
      const optionsSnapshotData = await optionsSnapshotRes.json();
      const snapshots = optionsSnapshotData.results || [];

      optionsWithGreeks = snapshots.map((snap: PolygonOptionSnapshot) => ({
        ticker: snap.details?.ticker || "",
        strikePrice: snap.details?.strike_price || 0,
        optionType: snap.details?.contract_type?.toLowerCase() || "call",
        expirationDate: snap.details?.expiration_date || expDate,
        lastPrice: snap.day?.close || snap.last_quote?.midpoint || 0,
        bid: snap.last_quote?.bid || 0,
        ask: snap.last_quote?.ask || 0,
        midpoint: snap.last_quote?.midpoint || 0,
        volume: snap.day?.volume || 0,
        openInterest: snap.open_interest || 0,
        impliedVolatility: snap.implied_volatility || 0,
        delta: snap.greeks?.delta || 0,
        gamma: snap.greeks?.gamma || 0,
        theta: snap.greeks?.theta || 0,
        vega: snap.greeks?.vega || 0,
      }));
    } else {
      // Fallback: use contract data without greeks
      optionsWithGreeks = contracts.map((c: PolygonContract) => ({
        ticker: c.ticker,
        strikePrice: c.strike_price,
        optionType: c.contract_type?.toLowerCase() || "call",
        expirationDate: c.expiration_date,
        lastPrice: 0,
        bid: 0,
        ask: 0,
        midpoint: 0,
        volume: 0,
        openInterest: 0,
        impliedVolatility: 0,
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
      }));
    }

    // Sort by strike price
    optionsWithGreeks.sort((a, b) => a.strikePrice - b.strikePrice);

    return NextResponse.json({
      ticker,
      currentPrice,
      expirationDate: expDate,
      dte,
      options: optionsWithGreeks,
    });
  } catch (err) {
    console.error("Options API error:", err);
    return NextResponse.json(
      { error: "Internal server error fetching options data" },
      { status: 500 }
    );
  }
}

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

interface PolygonOptionSnapshot {
  details?: {
    ticker?: string;
    strike_price?: number;
    contract_type?: string;
    expiration_date?: string;
  };
  day?: {
    close?: number;
    volume?: number;
  };
  last_quote?: {
    bid?: number;
    ask?: number;
    midpoint?: number;
  };
  open_interest?: number;
  implied_volatility?: number;
  greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
  };
}

interface PolygonContract {
  ticker: string;
  strike_price: number;
  contract_type?: string;
  expiration_date: string;
}
