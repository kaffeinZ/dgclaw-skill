// Backfill forward outcomes for harness rows, then JOIN + PRUNE + CAP so the dataset
// has a permanent ceiling. See HARNESS-PREREG.md (frozen 2026-08-02T16:50:05Z).
// Read-only with respect to trading: fetches candles, rewrites only harness files.
//
// WHY A CRON JOB, NOT A MANUAL STEP:
// signals.jsonl records no forward prices — outcomes are deferred so scans cost nothing
// and horizons can be re-cut. The price is a HARD 45-DAY DEADLINE: candleSnapshot retains
// ~45 days, so a row not backfilled by then is unrecoverable. Day one is covered by
// shipping this; what kills the study is silent failure at week six, so every run emits a
// staleness metric and escalates at 30 days — 15 days of headroom.
//
// WHY JOIN-THEN-PRUNE:
// A signal row without its outcome is unanalysable, and an outcome without its predictors
// is meaningless. Pruning either one alone destroys the pair. So the backfill merges them
// into one immutable record, writes it to a monthly archive, and only then drops the
// source rows. signals.jsonl becomes a short rolling buffer instead of an unbounded log.
//
// DEDUP IS A WATERMARK, NOT A SET:
// The scanner appends chronologically, so every row at or before the last fully-processed
// timestamp is done. That is O(1) memory — a done-set would grow to ~1M keys.
//
// Run: npx tsx scripts/backfill_outcomes.ts
import 'dotenv/config';
import fs from 'fs';
import zlib from 'zlib';
import readline from 'readline';

const ROOT = new URL('../', import.meta.url).pathname;
const SIGNALS_FILE = `${ROOT}signals.jsonl`;
const ARCHIVE_DIR = `${ROOT}harness`;
const WATERMARK_FILE = `${ROOT}.harness_watermark`;
// Written once, on the first run that archives anything. Marks the study window so the
// size cap can never evict data the active study depends on.
const STUDY_START_FILE = `${ROOT}.harness_study_start`;
const LOCK_FILE = `${ROOT}.scanner.lock`;
const HL_API_URL = process.env.HL_API_URL ?? 'https://api.hyperliquid.xyz';

const HORIZONS_H = [6, 24, 48] as const;   // frozen by the pre-registration
const MATURE_MS = 48 * 3_600_000;
const STALE_ALERT_DAYS = 30;
const RETENTION_DAYS = 45;
// 350 MB hard ceiling across all archives. Derived, not picked: joined records compress
// to ~66 bytes, so at 150-220 rows/scan x 96 scans/day this holds 8-12 MONTHS of data —
// six times the 6-week study window, on a disk with 8 GB free.
const CAP_BYTES = 350_000_000;

interface SignalRow { ts: number; symbol: string; direction: 'long' | 'short'; midPrice: number; dry?: boolean; }

async function hlPost(body: object): Promise<any> {
  const res = await fetch(`${HL_API_URL}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function eachLine(file: string, fn: (o: any, raw: string) => void): Promise<void> {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { fn(JSON.parse(line), line); } catch { /* torn final line */ }
  }
}

// Hold the scanner lock only for the fast rewrite, never for the slow candle fetching —
// otherwise a long backfill would block trading scans for minutes.
function withScannerLock<T>(fn: () => T): T | null {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    try { process.kill(pid, 0); console.log('PRUNE_DEFERRED | scanner is running; will prune next run'); return null; }
    catch { /* stale lock, safe to proceed */ }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  try { return fn(); } finally { try { fs.unlinkSync(LOCK_FILE); } catch {} }
}

// Eviction is oldest-first, which for a Fama-MacBeth beta series means silently losing
// the EARLIEST timestamps — truncating the sample in a way invisible in the results.
// So archives overlapping an active study are never evicted; the cap yields to study
// integrity and escalates instead. At 8-12 months of capacity against a 6-week study this
// should never fire, and every eviction that does happen is written into the study record.
function enforceCap(): void {
  if (!fs.existsSync(ARCHIVE_DIR)) return;
  const studyStart = fs.existsSync(STUDY_START_FILE)
    ? (fs.readFileSync(STUDY_START_FILE, 'utf-8').trim().slice(0, 7) || null) : null;

  const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.jsonl.gz')).sort(); // YYYY-MM sorts chronologically
  let total = files.reduce((a, f) => a + fs.statSync(`${ARCHIVE_DIR}/${f}`).size, 0);
  console.log(`CAP | archives=${files.length} bytes=${(total / 1e6).toFixed(1)}MB limit=${(CAP_BYTES / 1e6).toFixed(0)}MB study_start=${studyStart ?? 'none'}`);

  while (total > CAP_BYTES && files.length > 1) {
    const oldest = files[0];
    const month = oldest.replace('.jsonl.gz', '');
    if (studyStart && month >= studyStart) {
      console.error(`CAP_BLOCKED | over cap at ${(total / 1e6).toFixed(1)}MB but ${oldest} is inside the active study window (from ${studyStart}) — REFUSING to evict. Evicting it would truncate the earliest timestamps of the beta series invisibly. Free disk or end the study.`);
      return;
    }
    files.shift();
    const sz = fs.statSync(`${ARCHIVE_DIR}/${oldest}`).size;
    fs.unlinkSync(`${ARCHIVE_DIR}/${oldest}`);
    total -= sz;
    const note = `${new Date().toISOString()} evicted ${oldest} ${sz} bytes (pre-study)\n`;
    fs.appendFileSync(`${ARCHIVE_DIR}/EVICTIONS.log`, note);   // permanent part of the study record
    console.error(`CAP_EVICT | dropped ${oldest} (${(sz / 1e6).toFixed(1)}MB) — recorded in EVICTIONS.log`);
  }
}

async function main() {
  const now = Date.now();
  const watermark = fs.existsSync(WATERMARK_FILE) ? parseInt(fs.readFileSync(WATERMARK_FILE, 'utf-8').trim(), 10) || 0 : 0;

  const pending: SignalRow[] = [];
  let total = 0, dry = 0, done = 0;
  await eachLine(SIGNALS_FILE, (r: SignalRow) => {
    total++;
    if (r.dry) { dry++; return; }
    if (r.ts <= watermark) { done++; return; }
    if (now - r.ts < MATURE_MS) return;
    pending.push(r);
  });
  console.log(`rows=${total} dry=${dry} already_done=${done} pending=${pending.length} watermark=${watermark}`);

  // --- staleness, reported every run ---
  if (pending.length) {
    const oldest = Math.min(...pending.map(p => p.ts));
    const age = (now - oldest) / 86_400_000;
    const msg = `oldest_pending_age_days=${age.toFixed(1)} pending=${pending.length} retention=${RETENTION_DAYS}d`;
    if (age >= RETENTION_DAYS) console.error(`BACKFILL_STALE | DATA LOST | ${msg} — past candle retention, unrecoverable`);
    else if (age >= STALE_ALERT_DAYS) console.error(`BACKFILL_STALE | ${msg} — approaching the ${RETENTION_DAYS}d wall, intervene now`);
    else console.log(`BACKFILL_OK | ${msg}`);
  } else {
    console.log('BACKFILL_OK | oldest_pending_age_days=0 pending=0');
  }

  // --- compute outcomes, one candle fetch per symbol ---
  const bySymbol = new Map<string, SignalRow[]>();
  for (const p of pending) {
    const a = bySymbol.get(p.symbol);
    if (a) a.push(p); else bySymbol.set(p.symbol, [p]);
  }

  const joined = new Map<string, string[]>();  // YYYY-MM -> merged records
  let computed = 0, failed = 0, maxTs = watermark;
  for (const [symbol, rows] of bySymbol) {
    let candles: any[];
    try {
      candles = await hlPost({ type: 'candleSnapshot', req: { coin: symbol, interval: '15m', startTime: Math.min(...rows.map(r => r.ts)), endTime: Math.max(...rows.map(r => r.ts)) + MATURE_MS } });
      if (!Array.isArray(candles) || !candles.length) { failed += rows.length; continue; }
    } catch { failed += rows.length; continue; }

    const times = candles.map(c => c.t), closes = candles.map(c => parseFloat(c.c));
    const priceAt = (t: number): number | null => {
      let lo = 0, hi = times.length - 1, best = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { best = m; lo = m + 1; } else hi = m - 1; }
      return best >= 0 ? closes[best] : null;
    };

    for (const r of rows) {
      const rec: any = { ...r };            // JOIN: every predictor travels with its outcome
      delete rec.dry;
      for (const h of HORIZONS_H) {
        const px = priceAt(r.ts + h * 3_600_000);
        // DIRECTION-SIGNED: positive always means the signal was right.
        rec[`r${h}h`] = px && r.midPrice ? (r.direction === 'long' ? (px - r.midPrice) / r.midPrice : (r.midPrice - px) / r.midPrice) : null;
      }
      const month = new Date(r.ts).toISOString().slice(0, 7);
      (joined.get(month) ?? joined.set(month, []).get(month)!).push(JSON.stringify(rec));
      computed++;
      if (r.ts > maxTs) maxTs = r.ts;
    }
    await sleep(120);
  }

  // --- append merged records to monthly gzip archives ---
  if (joined.size) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    if (!fs.existsSync(STUDY_START_FILE)) {
      const earliest = [...joined.keys()].sort()[0];
      fs.writeFileSync(STUDY_START_FILE, earliest);
      console.log(`STUDY_START | ${earliest} — archives from this month on are protected from cap eviction`);
    }
    for (const [month, recs] of joined) {
      const f = `${ARCHIVE_DIR}/${month}.jsonl.gz`;
      fs.appendFileSync(f, zlib.gzipSync(Buffer.from(recs.join('\n') + '\n')));  // gzip members concatenate legally
    }
  }
  console.log(`computed=${computed} failed=${failed} archives_touched=${joined.size}`);

  // --- advance watermark, then prune signals.jsonl of everything at/below it ---
  if (computed && maxTs > watermark) {
    fs.writeFileSync(WATERMARK_FILE, String(maxTs));
    const pruned = withScannerLock(() => {
      const keep: string[] = [];
      let dropped = 0;
      const rl = fs.readFileSync(SIGNALS_FILE, 'utf-8').split('\n');
      for (const line of rl) {
        if (!line.trim()) continue;
        try { if (JSON.parse(line).ts <= maxTs) { dropped++; continue; } } catch {}
        keep.push(line);
      }
      fs.writeFileSync(`${SIGNALS_FILE}.tmp`, keep.length ? keep.join('\n') + '\n' : '');
      fs.renameSync(`${SIGNALS_FILE}.tmp`, SIGNALS_FILE);   // atomic
      return dropped;
    });
    if (pruned !== null) console.log(`PRUNE | dropped ${pruned} archived rows from signals.jsonl (buffer now rolling)`);
  }

  enforceCap();
  const bufBytes = fs.existsSync(SIGNALS_FILE) ? fs.statSync(SIGNALS_FILE).size : 0;
  console.log(`FOOTPRINT | signals_buffer=${(bufBytes / 1e6).toFixed(1)}MB`);
}

main().catch(e => { console.error(`backfill failed: ${e.message}`); process.exit(1); });
