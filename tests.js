// tests.js — run: node tests.js  (exits non-zero on failure)
import { createHash } from 'node:crypto';
import {
  STONES, DIG_COST, PERMIT, RELICS, FRAGMENTS,
  newPool, fragmentsLeft, hitChance, dig, bankValue, verifyExpedition,
  fullClearanceValue,
} from './rockpool.js';

let fails = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  ok ', name);
  else { fails++; console.error('  FAIL', name, detail ?? ''); }
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---- the pool
{
  const p = newPool();
  ok(p.stonesLeft === STONES && p.digs === 0, 'a fresh pool is untouched');
  ok(fragmentsLeft(p) === FRAGMENTS, 'all fragments start in the water');
  ok(Math.abs(hitChance(p) - FRAGMENTS / STONES) < 1e-12, 'opening odds are F/S');
}

// ---- digging
{
  let p = newPool();
  const out = dig(p, sha256('one'));
  ok(out.pool.stonesLeft === STONES - 1 && out.pool.digs === 1, 'a dig turns exactly one stone');
  ok(p.stonesLeft === STONES, 'dig never mutates the input pool');
  const again = dig(p, sha256('one'));
  ok(again.hit === out.hit && again.relic === out.relic, 'the same seed digs the same stone');
  const other = dig(p, sha256('two'));
  ok(typeof other.hit === 'boolean', 'different seeds are valid digs');
}
{
  // fragment conservation: turn every stone — every fragment must surface
  let p = newPool();
  for (let i = 0; i < STONES; i++) p = dig(p, sha256('all' + i)).pool;
  ok(fragmentsLeft(p) === 0, 'a full clearance surfaces every fragment');
  ok(p.banked.length === RELICS.length, 'every relic completes by the last stone');
  let threw = false;
  try { dig(p, sha256('extra')); } catch { threw = true; }
  ok(threw, 'the turned-over pool refuses another dig');
}

// ---- banking
{
  let p = newPool();
  for (let i = 0; i < STONES; i++) p = dig(p, sha256('bank' + i)).pool;
  const v = bankValue(p);
  const pays = RELICS.reduce((s, r) => s + r.pays * DIG_COST, 0);
  ok(v.payout === pays && v.spent === PERMIT + STONES * DIG_COST, 'full clearance banks all relics');
  ok(fullClearanceValue() === pays - STONES * DIG_COST - PERMIT, 'fullClearanceValue agrees');
  ok(fullClearanceValue() < 0, 'HOUSE RULE: turning every stone must lose — stopping is the game',
    'full clearance nets ' + fullClearanceValue());
}

// ---- verify replays whole expeditions
{
  const seeds = Array.from({ length: 12 }, (_, i) => sha256('exp' + i));
  const a = verifyExpedition(seeds), b = verifyExpedition(seeds);
  ok(JSON.stringify(a) === JSON.stringify(b), 'expeditions replay identically');
  ok(a.steps.length === 12 && a.spent === PERMIT + 12 * DIG_COST, 'twelve digs cost the permit plus twelve digs');
}

// ---- hypergeometric honesty: hit rate over many first digs ≈ F/S
{
  const N = 30_000; let hits = 0;
  for (let i = 0; i < N; i++) if (dig(newPool(), sha256('h' + i)).hit) hits++;
  const p = FRAGMENTS / STONES, sd = Math.sqrt(N * p * (1 - p));
  ok(Math.abs(hits - N * p) < 4 * sd, '30k first digs hit at F/S (4 sigma)',
    hits + ' vs ' + (N * p).toFixed(0));
}
{
  // conditional honesty: after a miss the odds RISE exactly as the urn says
  let rises = 0, total = 0;
  for (let i = 0; i < 2000; i++) {
    const out = dig(newPool(), sha256('c' + i));
    if (!out.hit) { total++; if (hitChance(out.pool) > hitChance(newPool())) rises++; }
  }
  ok(rises === total, 'a miss concentrates the remaining fragments');
}

// ---- WHICH fragment surfaces is fair: over many hits, in proportion to remaining
{
  const counts = { coin: 0, sextant: 0, figure: 0 };
  let hits = 0;
  for (let i = 0; i < 30_000; i++) {
    const out = dig(newPool(), sha256('w' + i));
    if (out.hit) { counts[out.relic]++; hits++; }
  }
  let fair = true;
  for (const r of RELICS) {
    const p = r.size / FRAGMENTS, got = counts[r.key] / hits;
    const sd = Math.sqrt(p * (1 - p) / hits);
    if (Math.abs(got - p) > 4.5 * sd) fair = false;
  }
  ok(fair, '30k digs: surfaced fragments track relic sizes (4.5 sigma)', JSON.stringify(counts));
}

// ---- THE ECONOMY: solve the stopping game exactly and pin the edge.
// State: (stonesLeft, left-per-relic). V = max(0, EV(dig) ) where banking
// completed relics is automatic; V is the value of the FUTURE only.
{
  const memo = new Map();
  const key = (s, l) => s + '|' + RELICS.map((r) => l[r.key]).join(',');
  function V(stonesLeft, left) {
    const F = Object.values(left).reduce((a, b) => a + b, 0);
    if (stonesLeft === 0 || F === 0) return 0;
    const k = key(stonesLeft, left);
    if (memo.has(k)) return memo.get(k);
    // EV of digging once, then playing on optimally
    const pHit = F / stonesLeft;
    let evHit = 0;
    for (const r of RELICS) {
      const l = left[r.key];
      if (l === 0) continue;
      const pThis = l / F;
      const nl = { ...left, [r.key]: l - 1 };
      const immediate = l === 1 ? r.pays * DIG_COST : 0; // completes the set
      evHit += pThis * (immediate + V(stonesLeft - 1, nl));
    }
    const evMiss = V(stonesLeft - 1, left);
    const evDig = -DIG_COST + pHit * evHit + (1 - pHit) * evMiss;
    const v = Math.max(0, evDig);
    memo.set(k, v);
    return v;
  }
  const start = newPool();
  const optimalEV = V(start.stonesLeft, start.left);
  // expected spend under the optimal policy (walk the same DP for E[spend])
  const memoS = new Map();
  function S(stonesLeft, left) {
    const F = Object.values(left).reduce((a, b) => a + b, 0);
    if (stonesLeft === 0 || F === 0) return 0;
    const k = key(stonesLeft, left);
    // recompute the dig/stop decision exactly as V did
    const pHit = F / stonesLeft;
    let evHit = 0;
    for (const r of RELICS) {
      const l = left[r.key]; if (l === 0) continue;
      const nl = { ...left, [r.key]: l - 1 };
      evHit += (l / F) * ((l === 1 ? r.pays * DIG_COST : 0) + V(stonesLeft - 1, nl));
    }
    const evDig = -DIG_COST + pHit * evHit + (1 - pHit) * V(stonesLeft - 1, left);
    if (evDig <= 0) return 0; // optimal play stops here
    if (memoS.has(k)) return memoS.get(k);
    let s = DIG_COST;
    for (const r of RELICS) {
      const l = left[r.key]; if (l === 0) continue;
      const nl = { ...left, [r.key]: l - 1 };
      s += pHit * (l / F) * S(stonesLeft - 1, nl);
    }
    s += (1 - pHit) * S(stonesLeft - 1, left);
    memoS.set(k, s);
    return s;
  }
  const optimalSpend = S(start.stonesLeft, start.left);
  // the permit is part of every expedition's cost; edge is measured on the
  // whole outlay under exact optimal play
  const edge = (PERMIT - optimalEV) / (PERMIT + optimalSpend);
  console.log(`   [calibration] optimal-play EV ${optimalEV.toFixed(2)} on expected spend ${optimalSpend.toFixed(2)} → house edge ${(edge * 100).toFixed(2)}%`);
  ok(optimalEV < PERMIT, 'optimal play never beats the house (dig value stays under the permit)', optimalEV.toFixed(2));
  ok(edge > 0.02 && edge < 0.05, 'house edge at optimal play is ≈3.6% (2–5% band)', (edge * 100).toFixed(2) + '%');
  ok(optimalSpend > 5 * DIG_COST, 'optimal play digs meaningfully (the game is playable)', optimalSpend.toFixed(1));
}

if (fails) { console.error(`\n${fails} failing`); process.exit(1); }
console.log('\nall tests pass');
