import 'dotenv/config';
import fs from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACP_DIR = process.env.ACP_CLI_DIR || resolve(__dirname, '..', '..', 'acp-cli');

function getAcpBin(): string {
  return `npx tsx ${resolve(ACP_DIR, 'bin', 'acp.ts')}`;
}

function derivePrimaryType(types: Record<string, any>): string {
  const keys = Object.keys(types).filter(k => k !== 'EIP712Domain');
  return keys[0] ?? '';
}

function makeAcpWallet(masterAddress: string) {
  const acp = getAcpBin();
  return {
    async getAddress(): Promise<string> {
      return masterAddress;
    },
    async signTypedData(domain: any, types: any, message: any): Promise<string> {
      const typedData = { domain, types, primaryType: derivePrimaryType(types), message };
      try {
        const result = execSync(
          `${acp} wallet sign-typed-data --data '${JSON.stringify(typedData)}' --json`,
          { encoding: 'utf-8', cwd: ACP_DIR, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const parsed = JSON.parse(result);
        const sig = parsed.signature ?? parsed.data?.signature ?? result.trim();
        if (!sig) throw new Error('No signature in response: ' + result);
        return sig;
      } catch (err: any) {
        const msg = err.stderr || err.stdout || err.message || String(err);
        console.error('ACP signing failed:', msg);
        throw err;
      }
    },
  };
}

const HL_API_URL = 'https://api.hyperliquid.xyz';
const MARGIN_PER_TRADE_USD = 10; // your capital at risk per trade (before leverage)
const LEVERAGE_LOW = 3;          // OI $500K–$5M
const LEVERAGE_HIGH = 5;         // OI $5M–$30M
const OI_LEVERAGE_THRESHOLD = 5_000_000;
const MAX_POSITIONS = 5;
const MIN_SL_PCT = 0.06; // minimum SL — skip trades with tighter supports (weak structure)
const MAX_SL_PCT = 0.08; // maximum SL — skip trades wider than 8% (high volatility)
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

const FORUM_BASE = 'https://degen.virtuals.io';
const FORUM_AGENT_ID = '1026';
const FORUM_SIGNALS_THREAD = '1023';

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
  entryHourlyMovePct?: number;  // price move % at entry time (for monitoring gate effectiveness)
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
  closeReason: 'fixed_sl' | 'trailing_stop' | 'signal_reversal';
  entryScore?: number;
  pnlUsd: number | null; // null for external tp/sl closes
  entrySignal: string;
}

interface TradeLog {
  trades: TradeLogEntry[];
}

interface ScannerState {
  positions: PositionEntry[];
  slCooldowns?: Record<string, number>; // symbol -> timestamp when cooldown expires
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

  // RSI proximity (0–15 pts): peak at RSI=30 (long oversold) / RSI=70 (short overbought)
  // LONG: max 15pts at RSI 30 (oversold), still 10pts at RSI 0, tapers to 0 above RSI 60
  // SHORT: max 15pts at RSI 70 (overbought), still 10pts at RSI 100, tapers to 0 below RSI 40
  if (direction === 'long') {
    score += Math.max(0, Math.min(15, 15 - Math.abs(rsi - 30) * 0.25));
  } else {
    score += Math.max(0, Math.min(15, 15 - Math.abs(rsi - 70) * 0.25));
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

  // Price vs VWAP (0–15 pts): 5-category scale: 15 @ -2.5%, 12 @ 0%, 7.5 @ +2.5%, 2.5 @ +5%, 0 @ +10%+
  // Two-piece formula to hit exact breakpoints
  if (vwap > 0) {
    const vwapDist = (lastClose - vwap) / vwap;
    let vwapScore = 0;

    if (direction === 'long') {
      // LONG: rewards price below VWAP (pullback entry)
      if (vwapDist <= 0.05) {
        // -2.5% to +5%: from 15 pts down to 2.5 pts
        vwapScore = 15 - (vwapDist + 0.025) * 166.67;
      } else {
        // +5% to +10%+: from 2.5 pts down to 0
        vwapScore = Math.max(0, 2.5 - (vwapDist - 0.05) * 50);
      }
    } else {
      // SHORT: rewards price above VWAP (pullback entry for shorts)
      if (vwapDist >= -0.05) {
        // +2.5% to -5%: from 15 pts down to 2.5 pts (mirrored)
        vwapScore = 15 - (-vwapDist + 0.025) * 166.67;
      } else {
        // -5% to -10%+: from 2.5 pts down to 0
        vwapScore = Math.max(0, 2.5 - (-vwapDist - 0.05) * 50);
      }
    }
    score += Math.min(15, Math.max(0, vwapScore));
  }

  // Volume build (0–20 pts): only award if OBV confirms direction (gated)
  // Scoring: 1.0-3.0x = scales 0-15pts, 3.0-5.0x = 15pts, 5.0x+ = 20pts max
  // OBV: >=3/5 steps rising = obvRising for longs, <3/5 = obvRising for shorts
  const obvRising = obvRisingCount >= 3;
  let volumeScore = 0;
  if (direction === 'long' && obvRising) {
    if (volumeBuildRatio < 3.0) volumeScore = Math.max(0, (volumeBuildRatio - 1.0) * 10);
    else if (volumeBuildRatio < 5.0) volumeScore = 15;
    else volumeScore = 20;
  } else if (direction === 'short' && !obvRising) {
    if (volumeBuildRatio < 3.0) volumeScore = Math.max(0, (volumeBuildRatio - 1.0) * 10);
    else if (volumeBuildRatio < 5.0) volumeScore = 15;
    else volumeScore = 20;
  }
  score += volumeScore;

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

async function generatePostContent(prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 350,
        temperature: 0.7,
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim() ?? null;
    // Reject suspiciously short responses — fall back to template
    return content && content.length >= 50 ? content : null;
  } catch {
    return null;
  }
}

function validatePnL(aiContent: string, expectedPnL: string): boolean {
  // Ensure AI response mentions the actual PnL (not hallucinated numbers)
  // Look for the PnL value (e.g., "$12.15", "-$6.07", "+$12.15")
  const cleanPnL = expectedPnL.replace('$', '').replace('+', '').trim();
  return aiContent.includes(cleanPnL);
}

async function postToForum(title: string, content: string): Promise<void> {
  const apiKey = process.env.DGCLAW_API_KEY;
  if (!apiKey) {
    console.log('FORUM: DGCLAW_API_KEY not set — skipping post');
    return;
  }
  try {
    const res = await fetch(`${FORUM_BASE}/api/forums/${FORUM_AGENT_ID}/threads/${FORUM_SIGNALS_THREAD}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ title, content }),
    });
    if (res.ok) {
      console.log(`FORUM: posted "${title}"`);
    } else {
      const text = await res.text();
      console.error(`FORUM: post failed ${res.status} — ${text.slice(0, 120)}`);
    }
  } catch (e: any) {
    console.error(`FORUM: post error — ${e.message}`);
  }
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
        // Distinguish between trailing stop (profit) and fixed SL (loss) based on P&L
        const exitType = realizedPnl !== null && realizedPnl > 0 ? 'trailing_stop' : 'fixed_sl';
        const exitLabel = exitType === 'trailing_stop' ? 'TRAILING_STOP' : 'FIXED_SL';
        console.log(`EXIT | ${tracked.symbol} ${tracked.direction.toUpperCase()} | reason=${exitLabel} | PnL=${realizedPnl !== null ? `$${realizedPnl.toFixed(4)}` : 'unknown'} | entry=${tracked.entryPrice ?? '?'} | SL=${tracked.slPrice ? formatPrice(tracked.slPrice) : '?'} | entryScore=${tracked.entryScore ?? '?'}`);

        // On FIXED_SL (loss): block re-entry on this symbol for 48h
        if (exitType === 'fixed_sl') {
          if (!state.slCooldowns) state.slCooldowns = {};
          const cooldownUntil = Date.now() + 48 * 3_600_000;
          state.slCooldowns[tracked.symbol.toUpperCase()] = cooldownUntil;
          console.log(`  SL_BLOCK | ${tracked.symbol} blocked for 48h (until ${new Date(cooldownUntil).toISOString()})`);
        }
        logTrade({ symbol: tracked.symbol, direction: tracked.direction, openTime: tracked.openTime, closeTime: Date.now(), closeReason: exitType, pnlUsd: realizedPnl, entrySignal: tracked.entrySignal ?? 'unknown', entryScore: tracked.entryScore });
        const heldH = ((Date.now() - tracked.openTime) / 3_600_000).toFixed(1);
        const slPnlStr = realizedPnl !== null ? `$${realizedPnl.toFixed(4)}` : 'unknown';
        const isTrailingStop = realizedPnl !== null && realizedPnl > 0;
        const exitTypeLabel = isTrailingStop ? 'Trailing stop locked' : 'Stop Loss hit';
        const slTitle = `Closed ${tracked.symbol} ${tracked.direction} — ${realizedPnl !== null && realizedPnl >= 0 ? '+' : ''}${slPnlStr} | ${exitTypeLabel}`;
        const slTemplate = `**${tracked.symbol} ${tracked.direction.toUpperCase()} closed — ${exitTypeLabel}** | PnL: ${slPnlStr} | Held: ${heldH}h | Entry score: ${tracked.entryScore ?? '?'}/100`;
        const slPrompt = `You are a crypto perp trader posting a trade close on a forum. Write 2-3 natural sentences about this ${isTrailingStop ? 'trailing stop' : 'stop loss'} exit. Be honest and brief.\n\nTrade: ${tracked.direction.toUpperCase()} ${tracked.symbol} | PnL: ${slPnlStr} | Held: ${heldH}h | Entry score: ${tracked.entryScore ?? '?'}/100 | ${isTrailingStop ? 'Trailing stop locked profit.' : 'Stop loss triggered.'}`;
        console.log(`LLM_PROMPT | SL exit | symbol=${tracked.symbol} | PnL=${slPnlStr} | prompt_length=${slPrompt.length}`);
        try {
          const aiContent = await generatePostContent(slPrompt);
          console.log(`LLM_RESPONSE | ${aiContent ? `${aiContent.substring(0, 60)}...` : 'null'}`);
          const aiResponse = aiContent && validatePnL(aiContent, slPnlStr) ? aiContent : slTemplate;
          console.log(`FORUM_POST | used=${aiContent && validatePnL(aiContent, slPnlStr) ? 'AI' : 'TEMPLATE'}`);
          await postToForum(slTitle, aiResponse);
        } catch {
          await postToForum(slTitle, slTemplate).catch(() => {});
        }
        continue;
      }

      const ageMs = Date.now() - tracked.openTime;
      const ageH = (ageMs / 3_600_000).toFixed(1);

      // Reversal exit — check if opposing 15m signal now scores > entry score (min 2h hold)
      const MIN_HOLD_REVERSAL_MS = 2 * 60 * 60 * 1000;
      const MIN_REVERSAL_SCORE_GAP = 5; // Require 5+ point gap to avoid noise exits
      if (tracked.entryScore && ageMs >= MIN_HOLD_REVERSAL_MS) {
        const oppositeDir = tracked.direction === 'long' ? 'short' : 'long';
        const reversalScore = await getReversalScore(tracked.symbol, oppositeDir);
        if (reversalScore > tracked.entryScore + MIN_REVERSAL_SCORE_GAP) {
          const unrealizedPnl = parseFloat((pos as any).unrealizedPnl ?? '0');
          console.log(`EXIT | ${tracked.symbol} ${tracked.direction.toUpperCase()} | reason=signal_reversal | PnL=$${unrealizedPnl.toFixed(4)} | entryScore=${tracked.entryScore} | reversalScore=${reversalScore} (${oppositeDir}) | held=${ageH}h | entry=${tracked.entryPrice ?? '?'} | SL=${tracked.slPrice ? formatPrice(tracked.slPrice) : '?'}`);
          const revTitle = `Closed ${tracked.symbol} ${tracked.direction} — ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(4)} | Signal reversal`;
          const revTemplate = `**${tracked.symbol} ${tracked.direction.toUpperCase()} closed — Signal reversal** | PnL: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(4)} | Held: ${ageH}h | Reversal score: ${reversalScore} vs entry: ${tracked.entryScore}`;
          const revPrompt = `You are a crypto perp trader posting a trade close on a forum. Write 2-3 natural sentences about this signal reversal exit. Be honest and brief.\n\nTrade: ${tracked.direction.toUpperCase()} ${tracked.symbol} | PnL: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(4)} | Held: ${ageH}h | Entry score: ${tracked.entryScore}/100 | Opposing ${oppositeDir} signal scored ${reversalScore} — momentum reversed.`;
          try {
            const aiContent = await generatePostContent(revPrompt);
            const revPnLStr = unrealizedPnl >= 0 ? `+$${unrealizedPnl.toFixed(4)}` : `-$${Math.abs(unrealizedPnl).toFixed(4)}`;
            const aiResponse = aiContent && validatePnL(aiContent, revPnLStr) ? aiContent : revTemplate;
            await postToForum(revTitle, aiResponse);
          } catch {
            await postToForum(revTitle, revTemplate).catch(() => {});
          }
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
            console.log(`TRAIL | ${tracked.symbol} ${tracked.direction.toUpperCase()} | ACTIVATED at +1R | SL locked at breakeven (hard floor — never goes below entry)`);
          }

          if (tracked.trailingActive) {
            // Stepped trailing: SL trails peak by 0.1R, hard floor at breakeven (entry price)
            // Locks profit in increments: +1R → +1.5R → +2R → +2.5R... as price rises
            const trailDistance = slDistance * 0.1; // Trail by 10% of risk below peak
            const hardFloor = tracked.entryPrice; // Breakeven — never go below
            const newSlPrice = isLong
              ? Math.max(tracked.peakPrice! - trailDistance, hardFloor)
              : Math.min(tracked.peakPrice! + trailDistance, hardFloor);

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

  const masterAddress = process.env.HL_MASTER_ADDRESS;

  if (!masterAddress) { console.error('HL_MASTER_ADDRESS not set'); process.exit(1); }

  const wallet = makeAcpWallet(masterAddress);
  const transport = new HttpTransport({ apiUrl: HL_API_URL });
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({ wallet: wallet as any, transport });

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
  const REVERSAL_ENTRY_SCORE = 65; // Higher bar for MA50/MA200 crossover entries
  const MA_CROSSOVER_PCT = 0.02; // MA50 within 2% of MA200 = potential crossover zone
  const MAX_HOURLY_MOVE_PCT = 0.15; // Skip if price moved >15% in last 1h (pump/dump trap)
  const seen = new Set<string>();
  // Purge expired SL cooldowns
  const now = Date.now();
  if (scanState.slCooldowns) {
    for (const sym of Object.keys(scanState.slCooldowns)) {
      if (scanState.slCooldowns[sym] <= now) delete scanState.slCooldowns[sym];
    }
  }

  const eligible = allResults.filter(r => {
    if (openCoins.has(r.symbol.toUpperCase())) return false;
    if (seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    // Block symbols on SL cooldown (48h after FIXED_SL)
    if (scanState.slCooldowns?.[r.symbol.toUpperCase()] && scanState.slCooldowns[r.symbol.toUpperCase()] > now) {
      const remainH = ((scanState.slCooldowns[r.symbol.toUpperCase()] - now) / 3_600_000).toFixed(1);
      console.log(`  SKIP ${r.symbol} — SL cooldown (${remainH}h remaining)`);
      return false;
    }
    // Score gate
    if (r.score < MIN_ENTRY_SCORE) return false;
    // Vol ratio gate — require meaningful volume build (not just noise)
    if (r.volumeBuildRatio < 3.0) return false;
    // Skip if price moved >15% in last 1h (already ran, late entry trap) — applies to all entries
    if (Math.abs(r.candleMovePct) > MAX_HOURLY_MOVE_PCT) return false;
    // Trend filter: LONGs need MA50>MA200, SHORTs need MA50<MA200
    // BUT: allow reversal entries at crossover (MA50 within 2% of MA200) if score ≥ 65
    if (r.ma50 !== null && r.ma200 !== null) {
      const maDiff = Math.abs(r.ma50 - r.ma200) / r.ma200; // % distance between MAs
      const atCrossover = maDiff < MA_CROSSOVER_PCT;

      if (r.direction === 'long') {
        if (r.ma50 < r.ma200) {
          // Bear trend: only allow if at crossover + high score (reversal entry)
          if (!atCrossover || r.score < REVERSAL_ENTRY_SCORE) return false;
        }
      } else if (r.direction === 'short') {
        if (r.ma50 > r.ma200) {
          // Bull trend: only allow if at crossover + high score (reversal entry)
          if (!atCrossover || r.score < REVERSAL_ENTRY_SCORE) return false;
        }
      }
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
    console.log(`\nNo asset met entry criteria (score≥${MIN_ENTRY_SCORE}) — no trade`);
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

      // Forum post — entry rationale
      const maDesc = best.ma50 !== null && best.ma200 !== null
        ? (best.ma50 > best.ma200 ? 'bullish (MA50 > MA200)' : 'bearish (MA50 < MA200)')
        : 'unknown';
      const vwapDesc = best.vwap > 0 ? `${((best.lastClose - best.vwap) / best.vwap * 100).toFixed(1)}% from VWAP` : '';
      const signalList = Object.entries(best.signals).filter(([, v]) => v).map(([k]) => k).join(', ');
      const crossNote = best.isCross ? `\n- **Golden/Death Cross**: yes — priority entry, overrides normal gates` : '';
      const entryTitle = `${best.direction === 'long' ? 'Long' : 'Short'} ${best.symbol} — Score ${best.score}/100 | RSI ${best.rsi.toFixed(1)} | Vol ${best.volumeBuildRatio.toFixed(2)}×`;
      const entryTemplate = `**${best.direction.toUpperCase()} ${best.symbol}** | Score: ${best.score}/100 | Entry: ${entryPrice} | SL: ${slPrice} (${(slPct * 100).toFixed(1)}%)\nRSI: ${best.rsi.toFixed(1)} | Vol: ${best.volumeBuildRatio.toFixed(2)}× | VWAP: ${vwapDesc} | Trend: ${maDesc}\nSignals: ${signalList}${crossNote}`;
      const entryPrompt = `You are a crypto perp trader posting a signal on a trading forum. Write a natural 3-4 sentence trading rationale. Start the first sentence with "${best.direction.toUpperCase()} ${best.symbol}" — always include the token name and direction. Be concise and confident, like a real trader — not robotic.\n\nTrade data:\n- ${best.direction.toUpperCase()} ${best.symbol}\n- Score: ${best.score}/100\n- RSI: ${best.rsi.toFixed(1)}\n- Volume build: ${best.volumeBuildRatio.toFixed(2)}× (recent vs prior candles)\n- Price vs VWAP: ${vwapDesc}\n- Trend: ${maDesc}\n- Signals fired: ${signalList}${best.isCross ? '\n- Golden/Death Cross fired — priority entry' : ''}\n- Entry: ${entryPrice} | SL: ${slPrice} (${(slPct * 100).toFixed(1)}% away)`;
      try {
        const aiContent = await generatePostContent(entryPrompt);
        await postToForum(entryTitle, aiContent ?? entryTemplate);
      } catch {
        await postToForum(entryTitle, entryTemplate).catch(() => {});
      }

      scanState.positions.push({
        symbol: best.symbol,
        direction: best.direction,
        openTime: Date.now(),
        assetIndex: best.assetIndex,
        szDecimals: best.szDecimals,
        entrySignal: (best as any).entrySignal,
        entryScore: best.score,
        entryPrice,
        entryHourlyMovePct: best.candleMovePct,
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
