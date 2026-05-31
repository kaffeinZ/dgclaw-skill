import 'dotenv/config';
import fs from 'fs';
import { privateKeyToAccount } from 'viem/accounts';
import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';

const HL_API_URL = 'https://api.hyperliquid.xyz';
const MARGIN_PER_TRADE_USD = 10; // your capital at risk per trade (before leverage)
const LEVERAGE_LOW = 3;          // OI $500K–$5M
const LEVERAGE_HIGH = 5;         // OI $5M–$30M
const OI_LEVERAGE_THRESHOLD = 5_000_000;
const MAX_POSITIONS = 5;
const MIN_SL_PCT = 0.04; // minimum SL — below 15m noise floor
const MAX_SL_PCT = 0.08; // skip trade if SL wider than 8% — too risky
const SL_BUFFER = 0.005; // 0.5% buffer beyond candle low/high
const OI_MIN_USD = 500_000;
const OI_MAX_USD = 30_000_000;
const CANDLE_COUNT = 220; // 220 × 15m = 55h — supports 200 MA calculation
const CANDLE_INTERVAL = '15m';
const CANDLE_INTERVAL_MS = 15 * 60 * 1000;
const RSI_PERIOD = 14;
const SCAN_DELAY_MS = 300;

const STATE_FILE = new URL('../positions.json', import.meta.url).pathname;
const TRADE_LOG_FILE = new URL('../trade_log.json', import.meta.url).pathname;
const LOCK_FILE = new URL('../.scanner.lock', import.meta.url).pathname;

const MAJORS = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'LTC',
  'AVAX', 'DOT', 'MATIC', 'POL', 'TRX', 'LINK', 'ATOM', 'UNI',
  'BCH', 'ETC', 'XMR', 'DASH', 'ZEC', 'XLM', 'ALGO', 'NEAR',
  'HBAR', 'FIL', 'ICP', 'SAND', 'AXS',
]);

interface PositionEntry {
  symbol: string;
  direction: 'long' | 'short';
  openTime: number;
  assetIndex: number;
  szDecimals: number;
  entrySignal?: 'greenCandles' | 'redCandles' | 'goldenCross' | 'deathCross' | 'none';
  entryScore?: number;
  entryPrice?: number;
  slPct?: number;
  slPrice?: number;    // current SL price — updated as trailing stop moves it
  trailingActive?: boolean;
  peakPrice?: number;  // highest price reached (longs) or lowest (shorts)
}

interface TradeLogEntry {
  symbol: string;
  direction: 'long' | 'short';
  openTime: number;
  closeTime: number;
  closeReason: 'tp_or_sl' | 'signal_reversal' | 'trailing_stop';
  entryScore?: number;
  pnlUsd: number | null; // null for external tp/sl closes
  entrySignal: string;
}

interface TradeLog {
  trades: TradeLogEntry[];
}

interface ScannerState {
  positions: PositionEntry[];
}

interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}


interface SignalResult {
  symbol: string;
  direction: 'long' | 'short';
  score: number;
  signals: Record<string, boolean>;
  midPrice: number;
  rsi: number;
  volumeBuildRatio: number;
  szDecimals: number;
  assetIndex: number;
  slPrice: number;
  candleMovePct: number;
  oiUsd: number;
  leverage: number;
  lastClose: number;
  ma50: number | null;
  ma200: number | null;
  vwap: number;
  isCross: boolean;
}

async function hlPost(body: object): Promise<any> {
  const res = await fetch(`${HL_API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calcRSI(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return [];
  const rsi: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function calcOBV(closes: number[], volumes: number[]): number[] {
  const obv: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv.push(obv[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
    else obv.push(obv[i - 1]);
  }
  return obv;
}


function calcVWAP(candles: Candle[]): number {
  let sumTPV = 0;
  let sumVol = 0;
  for (const c of candles) {
    const tp = (parseFloat(c.h) + parseFloat(c.l) + parseFloat(c.c)) / 3;
    const vol = parseFloat(c.v);
    sumTPV += tp * vol;
    sumVol += vol;
  }
  return sumVol === 0 ? 0 : sumTPV / sumVol;
}

async function analyzeAsset(
  symbol: string,
  midPrice: number,
  szDecimals: number,
  assetIndex: number,
  oiUsd: number,
  leverage: number,
): Promise<{ long: SignalResult | null; short: SignalResult | null }> {
  try {
    const now = Date.now();
    const startTime = now - CANDLE_COUNT * CANDLE_INTERVAL_MS;

    const candles: Candle[] = await hlPost({
      type: 'candleSnapshot',
      req: { coin: symbol, interval: CANDLE_INTERVAL, startTime, endTime: now },
    });

    if (!Array.isArray(candles) || candles.length < 20) return { long: null, short: null };

    const closes = candles.map(c => parseFloat(c.c));
    const highs = candles.map(c => parseFloat(c.h));
    const lows = candles.map(c => parseFloat(c.l));
    const opens = candles.map(c => parseFloat(c.o));
    const volumes = candles.map(c => parseFloat(c.v));
    const n = candles.length;

    const rsiValues = calcRSI(closes, RSI_PERIOD);
    if (rsiValues.length < 3) return { long: null, short: null };

    const lastRSI = rsiValues[rsiValues.length - 1];
    const obvValues = calcOBV(closes, volumes);
    const vwap = calcVWAP(candles);
    const lastClose = closes[n - 1];

    // OBV: 60% of last 5 steps must be rising (or falling for shorts)
    const obvLast6 = obvValues.slice(-6);
    let obvRisingCount = 0;
    for (let i = 1; i < obvLast6.length; i++) {
      if (obvLast6[i] > obvLast6[i - 1]) obvRisingCount++;
    }
    const obvRising = obvRisingCount >= 3;

    // RSI crossover: was below 30 (long) or above 70 (short) within last 8 candles (2 hours)
    const rsiWasOversold = rsiValues.slice(-8).some(v => v < 30);
    const rsiWasOverbought = rsiValues.slice(-8).some(v => v > 70);

    // Candle structure
    const prevOpen = opens[n - 2];
    const prevClose = closes[n - 2];
    const prevLow = lows[n - 2];
    const prevHigh = highs[n - 2];
    const lastOpen = opens[n - 1];

    // 2 consecutive same-direction candles
    const bothGreen = prevClose > prevOpen && lastClose > lastOpen;
    const bothRed = prevClose < prevOpen && lastClose < lastOpen;

    // Engulfing patterns: last candle body fully swallows previous candle body (scoring bonus only)
    const bullishEngulfing = prevClose < prevOpen && lastClose > lastOpen
      && lastOpen <= prevClose && lastClose >= prevOpen;
    const bearishEngulfing = prevClose > prevOpen && lastClose < lastOpen
      && lastOpen >= prevClose && lastClose <= prevOpen;

    // % price moved over the 2 candles
    const candleMovePct = closes[n - 3] > 0 ? Math.abs(lastClose - closes[n - 3]) / closes[n - 3] : 0;

    // Dynamic SL levels from first candle structure
    const longSLPrice = prevLow * (1 - SL_BUFFER);
    const shortSLPrice = prevHigh * (1 + SL_BUFFER);

    // Volume build ratio kept for sort tiebreaker only (no longer a signal)
    const recentAvgVol = (volumes[n - 1] + volumes[n - 2] + volumes[n - 3]) / 3;
    const priorAvgVol = (volumes[n - 4] + volumes[n - 5] + volumes[n - 6]) / 3;
    const volumeBuildRatio = priorAvgVol > 0 ? recentAvgVol / priorAvgVol : 0;

    // Moving averages — 50 MA (trend direction), 200 MA (long-term confirmation)
    const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50 : null;
    const ma200 = closes.length >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;
    // Previous MA values for golden/death cross detection
    const prevMa50 = closes.length >= 51 ? closes.slice(-51, -1).reduce((a, b) => a + b, 0) / 50 : null;
    const prevMa200 = closes.length >= 201 ? closes.slice(-201, -1).reduce((a, b) => a + b, 0) / 200 : null;
    const goldenCross = (ma50 !== null && ma200 !== null && prevMa50 !== null && prevMa200 !== null && prevMa50 <= prevMa200 && ma50 > ma200);
    const deathCross  = (ma50 !== null && ma200 !== null && prevMa50 !== null && prevMa200 !== null && prevMa50 >= prevMa200 && ma50 < ma200);

    const longBase: Record<string, boolean> = {
      rsi: lastRSI >= 30 && lastRSI <= 65,
      obv: obvRising,
      priceVsVwap: vwap > 0 && lastClose <= vwap * 1.05,
      greenCandles: bothGreen,
    };
    const shortBase: Record<string, boolean> = {
      rsi: lastRSI >= 35 && lastRSI <= 70,
      obv: !obvRising,
      priceVsVwap: vwap > 0 && lastClose >= vwap * 0.95,
      redCandles: bothRed,
    };

    if (goldenCross) console.log(`  ${symbol}: GOLDEN CROSS — 50 MA crossed above 200 MA`);
    if (deathCross)  console.log(`  ${symbol}: DEATH CROSS  — 50 MA crossed below 200 MA`);

    const longScore  = calcStrengthScore('long',  lastRSI, obvRisingCount, bullishEngulfing, bearishEngulfing, bothGreen, bothRed, vwap, lastClose, volumeBuildRatio, ma50, ma200, goldenCross, deathCross);
    const shortScore = calcStrengthScore('short', lastRSI, obvRisingCount, bullishEngulfing, bearishEngulfing, bothGreen, bothRed, vwap, lastClose, volumeBuildRatio, ma50, ma200, goldenCross, deathCross);

    return {
      long: { symbol, direction: 'long', score: longScore, signals: longBase, midPrice, rsi: lastRSI, volumeBuildRatio, szDecimals, assetIndex, slPrice: longSLPrice, candleMovePct, oiUsd, leverage, lastClose, ma50, ma200, vwap, isCross: goldenCross },
      short: { symbol, direction: 'short', score: shortScore, signals: shortBase, midPrice, rsi: lastRSI, volumeBuildRatio, szDecimals, assetIndex, slPrice: shortSLPrice, candleMovePct, oiUsd, leverage, lastClose, ma50, ma200, vwap, isCross: deathCross },
    };
  } catch {
    return { long: null, short: null };
  }
}

function calcStrengthScore(
  direction: 'long' | 'short',
  rsi: number,
  obvRisingCount: number,
  bullishEngulfing: boolean,
  bearishEngulfing: boolean,
  bothGreen: boolean,
  bothRed: boolean,
  vwap: number,
  lastClose: number,
  volumeBuildRatio: number,
  ma50: number | null,
  ma200: number | null,
  goldenCross: boolean,
  deathCross: boolean,
): number {
  let score = 0;

  // RSI proximity (0–15 pts): peak at RSI=45 (long) / RSI=55 (short) — rewards both oversold
  // bounces and healthy momentum entries; tapers smoothly toward extremes.
  if (direction === 'long') {
    score += Math.max(0, Math.min(15, 15 - Math.abs(rsi - 45) * 0.4));
  } else {
    score += Math.max(0, Math.min(15, 15 - Math.abs(rsi - 55) * 0.4));
  }

  // OBV (0–15 pts): 3.75 pts at 3/5, 11.25 pts at 4/5, 15 pts at 5/5
  const obvSteps = direction === 'long' ? obvRisingCount : (5 - obvRisingCount);
  score += Math.max(0, (obvSteps - 1) / 4) * 15;

  // Candle pattern (0–20 pts): same-direction candles 10pts + engulfing 10pts (additive)
  if (direction === 'long') {
    if (bothGreen) score += 10;
    if (bullishEngulfing) score += 10;
  } else {
    if (bothRed) score += 10;
    if (bearishEngulfing) score += 10;
  }

  // Price vs VWAP (0–15 pts): symmetric — rewards entries within 5% of VWAP on either side.
  // Price AT VWAP = 15pts (ideal pullback). Extended >5% above/below = 0pts.
  if (vwap > 0) {
    const vwapDist = (lastClose - vwap) / vwap;
    if (direction === 'long') {
      score += Math.min(15, Math.max(0, (0.05 - vwapDist) * 300));
    } else {
      score += Math.min(15, Math.max(0, (vwapDist + 0.05) * 300));
    }
  }

  // Volume build (0–20 pts): strongest win predictor. Needs 3× ratio to max out.
  score += Math.min(20, Math.max(0, (volumeBuildRatio - 1.0) * 10));

  // 50/200 double confirmation (+5 pts bonus)
  if (ma50 !== null && ma200 !== null) {
    if (direction === 'long' && ma50 > ma200) score += 5;
    if (direction === 'short' && ma50 < ma200) score += 5;
  }

  // Golden/Death cross (+10 pts bonus): 50 MA just crossed 200 MA
  if (goldenCross && direction === 'long')  score += 10;
  if (deathCross  && direction === 'short') score += 10;

  return Math.round(score);
}

function formatPrice(price: number): string {
  const sigFigs = Number(price.toPrecision(5));
  const str = sigFigs.toString();
  const dot = str.indexOf('.');
  // Hyperliquid rejects prices with more than 6 decimal places
  if (dot !== -1 && str.length - dot - 1 > 6) {
    return sigFigs.toFixed(6);
  }
  return str;
}

function formatSize(usdSize: number, price: number, szDecimals: number): string {
  return (usdSize / price).toFixed(szDecimals);
}

function extractFilledOrder(
  orderResult: any,
): { avgPx: number; totalSz: number } | null {
  const statuses = orderResult?.response?.data?.statuses;
  if (!Array.isArray(statuses)) return null;

  let totalSz = 0;
  let totalNotional = 0;

  for (const status of statuses) {
    const filled = status?.filled;
    if (!filled) continue;

    const fillSz = parseFloat(filled.totalSz ?? '0');
    const avgPx = parseFloat(filled.avgPx ?? '0');
    if (fillSz <= 0 || avgPx <= 0) continue;

    totalSz += fillSz;
    totalNotional += fillSz * avgPx;
  }

  if (totalSz <= 0 || totalNotional <= 0) return null;
  return { avgPx: totalNotional / totalSz, totalSz };
}

function createMockFilledOrderResult(totalSz: string, avgPx: string): any {
  return {
    status: 'ok',
    response: {
      type: 'order',
      data: {
        statuses: [
          {
            filled: {
              totalSz,
              avgPx,
              oid: 0,
            },
          },
        ],
      },
    },
  };
}

function hasOrderStatuses(orderResult: any): boolean {
  const statuses = orderResult?.response?.data?.statuses;
  return Array.isArray(statuses) && statuses.length > 0;
}

function loadState(): ScannerState {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { positions: [] }; }
}

function saveState(state: ScannerState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadTradeLog(): TradeLog {
  try { return JSON.parse(fs.readFileSync(TRADE_LOG_FILE, 'utf-8')); }
  catch { return { trades: [] }; }
}

function logTrade(entry: TradeLogEntry): void {
  const log = loadTradeLog();
  log.trades.push(entry);
  fs.writeFileSync(TRADE_LOG_FILE, JSON.stringify(log, null, 2));
}

async function getReversalScore(symbol: string, direction: 'long' | 'short'): Promise<number> {
  try {
    const now = Date.now();
    const startTime = now - CANDLE_COUNT * CANDLE_INTERVAL_MS;
    const candles: Candle[] = await hlPost({
      type: 'candleSnapshot',
      req: { coin: symbol, interval: CANDLE_INTERVAL, startTime, endTime: now },
    });
    if (!Array.isArray(candles) || candles.length < 20) return 0;

    const closes  = candles.map(c => parseFloat(c.c));
    const opens   = candles.map(c => parseFloat(c.o));
    const volumes = candles.map(c => parseFloat(c.v));
    const n = candles.length;

    const rsiValues = calcRSI(closes, RSI_PERIOD);
    if (rsiValues.length < 3) return 0;
    const lastRSI = rsiValues[rsiValues.length - 1];

    const obvValues = calcOBV(closes, volumes);
    const obvLast6 = obvValues.slice(-6);
    let obvRisingCount = 0;
    for (let i = 1; i < obvLast6.length; i++) {
      if (obvLast6[i] > obvLast6[i - 1]) obvRisingCount++;
    }

    const vwap      = calcVWAP(candles);
    const lastClose = closes[n - 1];
    const lastOpen  = opens[n - 1];
    const prevClose = closes[n - 2];
    const prevOpen  = opens[n - 2];

    const bothGreen        = prevClose > prevOpen && lastClose > lastOpen;
    const bothRed          = prevClose < prevOpen && lastClose < lastOpen;
    const bullishEngulfing = prevClose < prevOpen && lastClose > lastOpen && lastOpen <= prevClose && lastClose >= prevOpen;
    const bearishEngulfing = prevClose > prevOpen && lastClose < lastOpen && lastOpen >= prevClose && lastClose <= prevOpen;
    const recentAvgVol   = (volumes[n-1] + volumes[n-2] + volumes[n-3]) / 3;
    const priorAvgVol    = (volumes[n-4] + volumes[n-5] + volumes[n-6]) / 3;
    const volumeBuildRatio = priorAvgVol > 0 ? recentAvgVol / priorAvgVol : 0;

    const ma50     = closes.length >= 50  ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50   : null;
    const ma200    = closes.length >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;
    const prevMa50 = closes.length >= 51  ? closes.slice(-51, -1).reduce((a, b) => a + b, 0) / 50  : null;
    const prevMa200= closes.length >= 201 ? closes.slice(-201, -1).reduce((a, b) => a + b, 0) / 200 : null;
    const goldenCross = ma50 !== null && ma200 !== null && prevMa50 !== null && prevMa200 !== null && prevMa50 <= prevMa200 && ma50 > ma200;
    const deathCross  = ma50 !== null && ma200 !== null && prevMa50 !== null && prevMa200 !== null && prevMa50 >= prevMa200 && ma50 < ma200;

    return calcStrengthScore(direction, lastRSI, obvRisingCount, bullishEngulfing, bearishEngulfing, bothGreen, bothRed, vwap, lastClose, volumeBuildRatio, ma50, ma200, goldenCross, deathCross);
  } catch {
    return 0;
  }
}

async function checkStalePositions(
  exchange: ExchangeClient,
  info: InfoClient,
  masterAddress: string,
  state: ScannerState,
): Promise<ScannerState> {
  if (state.positions.length === 0) return state;

  const csState = await info.clearinghouseState({ user: masterAddress as `0x${string}` });
  const openMap = new Map<string, any>();
  for (const ap of csState.assetPositions as any[]) {
    if (parseFloat(ap.position.szi) !== 0) openMap.set(ap.position.coin.toUpperCase(), ap.position);
  }

  const remaining: PositionEntry[] = [];
  const mids: Record<string, string> = await hlPost({ type: 'allMids' });

  for (const tracked of state.positions) {
    try {
      const pos = openMap.get(tracked.symbol.toUpperCase());
      if (!pos) {
        let realizedPnl: number | null = null;
        try {
          const fills = await info.userFillsByTime({ user: masterAddress as `0x${string}`, startTime: tracked.openTime });
          const coinFills = (fills as any[]).filter(f =>
            f.coin?.toUpperCase() === tracked.symbol.toUpperCase() &&
            f.time >= tracked.openTime,
          );
          if (coinFills.length > 0) {
            realizedPnl = coinFills.reduce((sum: number, f: any) => sum + parseFloat(f.closedPnl ?? '0'), 0);
          }
        } catch {
          // ignore — pnlUsd stays null
        }
        console.log(`EXIT | ${tracked.symbol} ${tracked.direction.toUpperCase()} | reason=SL_hit | PnL=${realizedPnl !== null ? `$${realizedPnl.toFixed(4)}` : 'unknown'} | entry=${tracked.entryPrice ?? '?'} | SL=${tracked.slPrice ? formatPrice(tracked.slPrice) : '?'} | entryScore=${tracked.entryScore ?? '?'}`);
        logTrade({ symbol: tracked.symbol, direction: tracked.direction, openTime: tracked.openTime, closeTime: Date.now(), closeReason: 'tp_or_sl', pnlUsd: realizedPnl, entrySignal: tracked.entrySignal ?? 'unknown' });
        continue;
      }

      const ageMs = Date.now() - tracked.openTime;
      const ageH = (ageMs / 3_600_000).toFixed(1);

      // Reversal exit — check if opposing 15m signal now scores > entry score (min 2h hold)
      const MIN_HOLD_REVERSAL_MS = 2 * 60 * 60 * 1000;
      if (tracked.entryScore && ageMs >= MIN_HOLD_REVERSAL_MS) {
        const oppositeDir = tracked.direction === 'long' ? 'short' : 'long';
        const reversalScore = await getReversalScore(tracked.symbol, oppositeDir);
        if (reversalScore > tracked.entryScore) {
          const unrealizedPnl = parseFloat((pos as any).unrealizedPnl ?? '0');
          console.log(`EXIT | ${tracked.symbol} ${tracked.direction.toUpperCase()} | reason=signal_reversal | PnL=$${unrealizedPnl.toFixed(4)} | entryScore=${tracked.entryScore} | reversalScore=${reversalScore} (${oppositeDir}) | held=${ageH}h | entry=${tracked.entryPrice ?? '?'} | SL=${tracked.slPrice ? formatPrice(tracked.slPrice) : '?'}`);
          try {
            const openOrders = await info.openOrders({ user: masterAddress as `0x${string}` });
            const slOrders = (openOrders as any[]).filter(o =>
              o.coin?.toUpperCase() === tracked.symbol.toUpperCase() &&
              o.orderType?.toLowerCase().includes('stop'),
            );
            for (const o of slOrders) {
              await exchange.cancel({ cancels: [{ a: tracked.assetIndex, o: o.oid }] });
            }
          } catch { /* ignore cancel errors */ }

          const sz = Math.abs(parseFloat(pos.szi)).toString();
          const isLong = parseFloat(pos.szi) > 0;
          const midPrice = parseFloat(mids[tracked.symbol] ?? '0');
          if (!midPrice) {
            console.error(`  ${tracked.symbol}: mid price unavailable — skipping reversal close, will retry`);
            remaining.push(tracked);
          } else {
            const closePrice = formatPrice(midPrice * (isLong ? 0.99 : 1.01));
            const result = await exchange.order({
              orders: [{ a: tracked.assetIndex, b: !isLong, r: true, p: closePrice, s: sz, t: { limit: { tif: 'Ioc' } } }],
              grouping: 'na',
            });
            if (extractFilledOrder(result)) {
              logTrade({ symbol: tracked.symbol, direction: tracked.direction, openTime: tracked.openTime, closeTime: Date.now(), closeReason: 'signal_reversal', pnlUsd: unrealizedPnl, entrySignal: tracked.entrySignal ?? 'unknown', entryScore: tracked.entryScore });
            } else {
              console.error(`  ${tracked.symbol}: reversal close did not fill — keeping in state, will retry`);
              remaining.push(tracked);
            }
          }
          continue;
        } else {
          console.log(`${tracked.symbol}: ${ageH}h | reversal ${oppositeDir} scores ${reversalScore} vs entry ${tracked.entryScore} — holding`);
        }
      }

      {
        // Trailing stop — runs every scan for positions that stored entry data
        const midPrice = parseFloat(mids[tracked.symbol] ?? '0');
        const isLong = parseFloat(pos.szi) > 0;
        const unrealizedPnl = parseFloat((pos as any).unrealizedPnl ?? '0');

        if (midPrice && tracked.entryPrice && tracked.slPct) {
          const slDistance = tracked.entryPrice * tracked.slPct;

          // Track peak (best price reached in our direction)
          if (isLong) {
            tracked.peakPrice = Math.max(tracked.peakPrice ?? tracked.entryPrice, midPrice);
          } else {
            tracked.peakPrice = Math.min(tracked.peakPrice ?? tracked.entryPrice, midPrice);
          }

          // Activate trailing once price moves >= 1R in our favour
          const moveInFavour = isLong
            ? midPrice - tracked.entryPrice
            : tracked.entryPrice - midPrice;

          if (!tracked.trailingActive && moveInFavour >= slDistance) {
            tracked.trailingActive = true;
            console.log(`TRAIL | ${tracked.symbol} ${tracked.direction.toUpperCase()} | ACTIVATED at ${midPrice.toPrecision(5)} (+${(moveInFavour / tracked.entryPrice * 100).toFixed(1)}% from entry ${tracked.entryPrice}) | SL moves to breakeven`);
          }

          if (tracked.trailingActive) {
            // New SL trails peak by 0.5× SL distance — locks profit quickly
            const trailDistance = slDistance * 0.5;
            const newSlPrice = isLong
              ? tracked.peakPrice! - trailDistance
              : tracked.peakPrice! + trailDistance;

            // Only update if SL has improved by >0.2% (avoid order spam)
            const currentSl = tracked.slPrice ?? 0;
            const improved = isLong
              ? newSlPrice > currentSl * 1.002
              : (currentSl === 0 || newSlPrice < currentSl * 0.998);

            if (improved) {
              try {
                const openOrders = await info.openOrders({ user: masterAddress as `0x${string}` });
                const slOrders = (openOrders as any[]).filter(o =>
                  o.coin?.toUpperCase() === tracked.symbol.toUpperCase() &&
                  o.orderType?.toLowerCase().includes('stop'),
                );
                for (const o of slOrders) {
                  await exchange.cancel({ cancels: [{ a: tracked.assetIndex, o: o.oid }] });
                }
              } catch { /* ignore cancel errors */ }

              await sleep(500);

              const sz = Math.abs(parseFloat(pos.szi)).toString();
              const newSlFormatted = formatPrice(newSlPrice);
              const slResult = await exchange.order({
                orders: [{ a: tracked.assetIndex, b: !isLong, r: true, p: newSlFormatted, s: sz, t: { trigger: { triggerPx: newSlFormatted, isMarket: true, tpsl: 'sl' } } }],
                grouping: 'na',
              });

              if (hasOrderStatuses(slResult)) {
                console.log(`TRAIL | ${tracked.symbol} ${tracked.direction.toUpperCase()} | SL moved → ${newSlFormatted} | peak=${formatPrice(tracked.peakPrice!)} | locked=${((Math.abs(tracked.peakPrice! - tracked.entryPrice!) / tracked.entryPrice!) * 100 / 2).toFixed(1)}% | PnL=$${unrealizedPnl.toFixed(4)}`);
                tracked.slPrice = newSlPrice;
              } else {
                console.error(`${tracked.symbol}: trailing SL order failed — keeping old SL`);
              }
            }
          }

          const trailStatus = tracked.trailingActive
            ? `trailing SL @ ${tracked.slPrice ? formatPrice(tracked.slPrice) : '?'}`
            : `waiting 1R (+${(slDistance / tracked.entryPrice * 100).toFixed(1)}%)`;
          console.log(`${tracked.symbol}: ${ageH}h | PnL $${unrealizedPnl.toFixed(2)} | ${trailStatus}`);
        } else {
          console.log(`${tracked.symbol}: ${ageH}h | PnL $${unrealizedPnl.toFixed(2)} | no entry data (pre-upgrade position)`);
        }

        remaining.push(tracked);
      }
    } catch (err: any) {
      console.error(`  ${tracked.symbol}: unexpected error during position check — keeping in state: ${err.message}`);
      remaining.push(tracked);
    }
  }

  return { positions: remaining };
}

async function main() {
  // --- Lock file: prevent two instances running simultaneously ---
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0); // check if process is still alive
      console.log(`Scanner already running (PID ${pid}) — exiting`);
      process.exit(0);
    } catch {
      console.log(`Stale lock file (PID ${pid} not running) — removing and continuing`);
      fs.unlinkSync(LOCK_FILE);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const removeLock = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', removeLock);
  process.on('SIGINT', () => { removeLock(); process.exit(0); });
  process.on('SIGTERM', () => { removeLock(); process.exit(0); });

  const apiWalletKey = process.env.HL_API_WALLET_KEY;
  const masterAddress = process.env.HL_MASTER_ADDRESS;

  if (!apiWalletKey) { console.error('HL_API_WALLET_KEY not set'); process.exit(1); }
  if (!masterAddress) { console.error('HL_MASTER_ADDRESS not set'); process.exit(1); }

  const account = privateKeyToAccount(apiWalletKey as `0x${string}`);
  const transport = new HttpTransport({ apiUrl: HL_API_URL });
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({ wallet: account, transport });

  const paperEntry = process.argv.includes('--paper-entry');
  const dryRun = process.argv.includes('--dry-run') || paperEntry;

  console.log(`Trade config: $${MARGIN_PER_TRADE_USD} margin per trade | ${LEVERAGE_LOW}x–${LEVERAGE_HIGH}x leverage (by OI tier) | max ${MAX_POSITIONS} positions | $${MARGIN_PER_TRADE_USD * MAX_POSITIONS} total margin needed`);

  // Check and close stale positions (24h hard exit)
  let scanState = loadState();
  if (!dryRun) {
    scanState = await checkStalePositions(exchange, info, masterAddress, scanState);
    saveState(scanState);
  }

  // Auto-sync: add any on-chain positions missing from state
  const state = await info.clearinghouseState({ user: masterAddress as `0x${string}` });
  const openPositions = (state.assetPositions as any[]).filter(p => parseFloat(p.position.szi) !== 0);
  if (!dryRun) {
    const [meta]: [any, any[]] = await hlPost({ type: 'metaAndAssetCtxs' });
    const assetMap = new Map<string, { index: number; szDecimals: number }>();
    for (let i = 0; i < meta.universe.length; i++) assetMap.set(meta.universe[i].name.toUpperCase(), { index: i, szDecimals: meta.universe[i].szDecimals });
    const stateCoins = new Set(scanState.positions.map(p => p.symbol.toUpperCase()));
    for (const ap of openPositions) {
      const coin = ap.position.coin.toUpperCase();
      if (!stateCoins.has(coin)) {
        const asset = assetMap.get(coin);
        const dir = parseFloat(ap.position.szi) > 0 ? 'long' : 'short';
        console.log(`Auto-sync: ${coin} found on-chain but missing from state — adding`);
        scanState.positions.push({ symbol: coin, direction: dir, openTime: Date.now(), assetIndex: asset?.index ?? -1, szDecimals: asset?.szDecimals ?? 0 });
      }
    }
    saveState(scanState);
  }
  const openCoins = new Set(openPositions.map((p: any) => p.position.coin.toUpperCase()));
  if (!dryRun && openPositions.length >= MAX_POSITIONS) {
    const coins = openPositions.map((p: any) => p.position.coin).join(', ');
    console.log(`At max positions (${MAX_POSITIONS}): ${coins} — skipping scan`);
    return;
  }
  if (paperEntry) console.log(`[PAPER ENTRY] Scanning and simulating fills without placing live orders...`);
  else if (dryRun) console.log(`[DRY RUN] Scanning regardless of position count...`);
  console.log(`Open positions: ${openPositions.length}/${MAX_POSITIONS} — scanning for more...`);

  // Fetch all assets + OI
  const [meta, assetCtxs]: [any, any[]] = await hlPost({ type: 'metaAndAssetCtxs' });
  const mids: Record<string, string> = await hlPost({ type: 'allMids' });

  const candidates: Array<{ symbol: string; midPrice: number; szDecimals: number; assetIndex: number; oiUsd: number; leverage: number }> = [];

  for (let i = 0; i < meta.universe.length; i++) {
    const asset = meta.universe[i];
    const ctx = assetCtxs[i];
    const symbol: string = asset.name;

    if (MAJORS.has(symbol)) continue;
    const midPrice = parseFloat(mids[symbol] ?? '0');
    if (!midPrice) continue;
    const oiUsd = parseFloat(ctx.openInterest ?? '0') * midPrice;
    if (oiUsd < OI_MIN_USD || oiUsd > OI_MAX_USD) continue;
    const leverage = oiUsd >= OI_LEVERAGE_THRESHOLD ? LEVERAGE_HIGH : LEVERAGE_LOW;
    if ((asset.maxLeverage ?? 1) < leverage) continue;

    candidates.push({ symbol, midPrice, szDecimals: asset.szDecimals, assetIndex: i, oiUsd, leverage });
  }

  console.log(`Scanning ${candidates.length} candidates (OI $${(OI_MIN_USD / 1e6).toFixed(1)}M–$${(OI_MAX_USD / 1e6).toFixed(0)}M, excl. majors)...`);

  const allResults: SignalResult[] = [];
  for (const c of candidates) {
    const { long, short } = await analyzeAsset(c.symbol, c.midPrice, c.szDecimals, c.assetIndex, c.oiUsd, c.leverage);
    if (long) allResults.push(long);
    if (short) allResults.push(short);
    await sleep(SCAN_DELAY_MS);
  }

  // Sort: highest continuous score first; smallest candle move as tiebreaker (freshest entry)
  allResults.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candleMovePct - b.candleMovePct;
  });

  console.log('\nTop candidates:');
  for (const r of allResults.slice(0, 5)) {
    const passed = Object.entries(r.signals).filter(([, v]) => v).map(([k]) => k).join(', ');
    console.log(`  ${r.symbol} ${r.direction.toUpperCase()}: ${r.score}/100 — RSI ${r.rsi.toFixed(1)} — volRatio ${r.volumeBuildRatio.toFixed(2)} — move ${(r.candleMovePct * 100).toFixed(2)}% — passed: [${passed}]`);
  }

  const slotsAvailable = dryRun ? MAX_POSITIONS : MAX_POSITIONS - openPositions.length;

  // OBV hard gate; RSI hard gates; 50 MA directional gate; min score = 60
  // Candle pattern is scored only — not a hard gate
  // EXCEPTION: golden/death cross bypasses ALL gates and enters as priority
  const MIN_ENTRY_SCORE = 60;
  const seen = new Set<string>();
  const eligible = allResults.filter(r => {
    if (openCoins.has(r.symbol.toUpperCase())) return false;
    if (seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    // Golden/death cross: priority entry — bypass all hard gates and score
    if (r.isCross) return true;
    // Normal entry gates
    if (!r.signals.obv) return false;
    if (r.score < MIN_ENTRY_SCORE) return false;
    if (r.direction === 'long'  && r.rsi > 75) return false;
    if (r.direction === 'short' && r.rsi < 25) return false;
    if (r.ma50 !== null) {
      if (r.direction === 'long' && r.lastClose < r.ma50) return false;
      if (r.direction === 'short' && r.lastClose > r.ma50) return false;
    }
    return true;
  });

  // Tag each eligible result with entry signal type
  for (const r of eligible) {
    const candleSignal = r.direction === 'long' ? 'greenCandles' : 'redCandles';
    const hasCandles = r.signals[candleSignal];
    if (r.isCross) {
      (r as any).entrySignal = r.direction === 'long' ? 'goldenCross' : 'deathCross';
    } else {
      (r as any).entrySignal = hasCandles ? candleSignal : 'none';
    }
  }

  // Sort: cross entries first (priority), then by score
  eligible.sort((a, b) => {
    if (a.isCross && !b.isCross) return -1;
    if (!a.isCross && b.isCross) return 1;
    return b.score - a.score;
  });

  if (eligible.length === 0) {
    console.log(`\nNo asset met entry criteria (OBV hard gate, RSI gates, 50 MA gate, score≥${MIN_ENTRY_SCORE}) — no trade`);
    return;
  }

  const toTrade = eligible.slice(0, slotsAvailable);
  if (dryRun && !paperEntry) {
    console.log(`\n[DRY RUN] Would open ${toTrade.length} position(s) — no orders placed`);
    return;
  }
  if (paperEntry) console.log(`\n[PAPER ENTRY] Simulating ${toTrade.length} new position(s)...`);
  else console.log(`\nOpening ${toTrade.length} new position(s)...`);

  for (const best of toTrade) {
    const isLong = best.direction === 'long';
    const estimatedEntryPrice = best.midPrice;
    const estimatedDynamicSlDistance = Math.abs(estimatedEntryPrice - best.slPrice);
    const estimatedDynamicSlPct = estimatedDynamicSlDistance / estimatedEntryPrice;

    if (estimatedDynamicSlPct > MAX_SL_PCT) {
      console.log(`  ${best.symbol}: SL too wide (${(estimatedDynamicSlPct * 100).toFixed(1)}%) — skipping`);
      continue;
    }

    const requestedSz = formatSize(MARGIN_PER_TRADE_USD * best.leverage, estimatedEntryPrice, best.szDecimals);
    const slippage = isLong ? 1.01 : 0.99;
    const orderPrice = formatPrice(estimatedEntryPrice * slippage);

    console.log(`\nOpening ${best.direction.toUpperCase()} ${best.symbol}`);
    console.log(`  Margin: $${MARGIN_PER_TRADE_USD} | ${best.leverage}x leverage | $${MARGIN_PER_TRADE_USD * best.leverage} notional | OI: $${(best.oiUsd / 1e6).toFixed(1)}M | Estimated entry: ~${estimatedEntryPrice}`);

    try {
      if (!paperEntry) {
        await exchange.updateLeverage({ asset: best.assetIndex, isCross: true, leverage: best.leverage });
      }

      const orderResult = paperEntry
        ? createMockFilledOrderResult(requestedSz, orderPrice)
        : await exchange.order({
            orders: [{ a: best.assetIndex, b: isLong, r: false, p: orderPrice, s: requestedSz, t: { limit: { tif: 'Ioc' } } }],
            grouping: 'na',
          });
      console.log(`${paperEntry ? 'Paper order result' : 'Order result'}:`, JSON.stringify(orderResult, null, 2));

      const fill = extractFilledOrder(orderResult);
      if (!fill) {
        console.log(`  ${best.symbol}: entry did not fill — skipping TP/SL placement`);
        continue;
      }

      const entryPrice = fill.avgPx;
      const sz = fill.totalSz.toFixed(best.szDecimals);
      const dynamicSlDistance = Math.abs(entryPrice - best.slPrice);
      const dynamicSlPct = dynamicSlDistance / entryPrice;

      if (dynamicSlPct > MAX_SL_PCT) {
        console.log(`  ${best.symbol}: real fill moved SL to ${(dynamicSlPct * 100).toFixed(1)}% away — ${paperEntry ? 'would close immediately' : 'closing immediately'}`);

        if (!paperEntry) {
          const closePrice = formatPrice(entryPrice * (isLong ? 0.99 : 1.01));
          const closeResult = await exchange.order({
            orders: [{ a: best.assetIndex, b: !isLong, r: true, p: closePrice, s: sz, t: { limit: { tif: 'Ioc' } } }],
            grouping: 'na',
          });
          console.log('Immediate close result:', JSON.stringify(closeResult, null, 2));
        }
        continue;
      }

      const slPct = Math.max(dynamicSlPct, MIN_SL_PCT);
      const slDistance = entryPrice * slPct;
      const slPrice = formatPrice(isLong ? entryPrice - slDistance : entryPrice + slDistance);

      if (dynamicSlPct < MIN_SL_PCT) {
        console.log(`  Dynamic SL was ${(dynamicSlPct * 100).toFixed(1)}% away from real fill — widened to minimum ${(MIN_SL_PCT * 100).toFixed(1)}%`);
      }

      // Full entry signal log — source for forum posts
      const vwapDistPct2 = best.vwap > 0 ? ((best.lastClose - best.vwap) / best.vwap * 100).toFixed(1) : 'n/a';
      const maAlign2 = best.ma50 !== null && best.ma200 !== null
        ? (best.ma50 > best.ma200 ? 'bull(MA50>MA200)' : 'bear(MA50<MA200)')
        : 'unknown';
      const passedSignals2 = Object.entries(best.signals).filter(([, v]) => v).map(([k]) => k).join(', ');
      console.log(`ENTRY | ${best.symbol} ${best.direction.toUpperCase()} | score=${best.score}/100 | RSI=${best.rsi.toFixed(1)} | vol=${best.volumeBuildRatio.toFixed(2)}x | VWAP=${vwapDistPct2}% | MA=${maAlign2}${best.isCross ? ' | CROSS=true' : ''} | signals=[${passedSignals2}] | entry=${entryPrice} | SL=${slPrice} (${(slPct * 100).toFixed(1)}%)`);

      if (paperEntry) {
        console.log(`  [PAPER ENTRY] Would set SL: ${slPrice} for size ${sz}`);
        continue;
      }

      await sleep(1000);

      const slResult = await exchange.order({
        orders: [{ a: best.assetIndex, b: !isLong, r: true, p: slPrice, s: sz, t: { trigger: { triggerPx: slPrice, isMarket: true, tpsl: 'sl' } } }],
        grouping: 'na',
      });
      console.log('SL order result:', JSON.stringify(slResult, null, 2));
      if (!hasOrderStatuses(slResult)) {
        console.error(`  ${best.symbol}: SL order response did not contain statuses — closing position for safety`);
        try {
          const openOrders = await info.openOrders({ user: masterAddress as `0x${string}` });
          const triggerOrders = (openOrders as any[]).filter(
            o => o.coin?.toUpperCase() === best.symbol.toUpperCase() && o.orderType?.includes('trigger'),
          );
          for (const o of triggerOrders) {
            await exchange.cancel({ cancels: [{ a: best.assetIndex, o: o.oid }] });
          }
        } catch {
          // Ignore cleanup failures and still attempt a marketable close
        }

        const closePrice = formatPrice(entryPrice * (isLong ? 0.99 : 1.01));
        const closeResult = await exchange.order({
          orders: [{ a: best.assetIndex, b: !isLong, r: true, p: closePrice, s: sz, t: { limit: { tif: 'Ioc' } } }],
          grouping: 'na',
        });
        console.log('Safety close result:', JSON.stringify(closeResult, null, 2));
        continue;
      }
      console.log(`SL set: ${slPrice}`);

      scanState.positions.push({
        symbol: best.symbol,
        direction: best.direction,
        openTime: Date.now(),
        assetIndex: best.assetIndex,
        szDecimals: best.szDecimals,
        entrySignal: (best as any).entrySignal,
        entryScore: best.score,
        entryPrice,
        slPct,
        slPrice: parseFloat(slPrice),
        trailingActive: false,
        peakPrice: entryPrice,
      });
      saveState(scanState);
    } catch (err: any) {
      console.error(`  Failed to open ${best.symbol}: ${err.message} — skipping`);
    }
  }

  if (paperEntry) {
    console.log(`\n[PAPER ENTRY] Done — simulated ${toTrade.map(t => `${t.symbol} ${t.direction} (${t.score}/100)`).join(', ')}.`);
  } else {
    console.log(`\nDone — ${toTrade.map(t => `${t.symbol} ${t.direction} (${t.score}/100)`).join(', ')} open. Next scan in 15 min.`);
  }
}

main().catch(err => {
  console.error('Scanner error:', err.message);
  process.exit(1);
});
