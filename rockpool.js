// rockpool.js — pure urn maths for Rockpool.
//
// Same discipline as the rest of the fleet: no DOM, no clock, no network,
// no crypto. The caller supplies hex seeds; everything here is a pure
// function of its arguments.
//
// THE URN, and why there is no hidden layout to steal:
// a fixed relic layout can't stay secret on a pure client-side provable
// game — whoever can verify it can precompute it. So the relics are not
// anywhere until the tide decides: the pool starts as "S stones, F of them
// hiding fragments", and each dig draws from WHAT REMAINS —
//     P(hit) = fragments remaining / stones remaining
// which is mathematically identical to a fixed hidden layout revealed one
// stone at a time (hypergeometric), but with nothing to leak. Each dig's
// draw comes from its own seed (practice: a local chain; the tide, later:
// one block per dig), so every single dig verifies independently.
//
// THE DECISION — this is a stopping game, not a scratch card:
// every dig costs the same price; completed relics pay out; you may bank
// and walk after any stone. Because the fragment density shifts with every
// reveal, "dig or bank" is a real, informed choice — the whole game.

export const STONES = 25;
export const DIG_COST = 10;          // the price of turning one stone
// The tide permit: the entry fee for an expedition. The urn's endgame digs
// are near-certain hits (fragments concentrate as stones deplete), so any
// payout table worth starting is worth finishing — in-dig pricing alone
// flips between "never dig" and player-positive with nothing in between.
// The permit absorbs the surplus while leaving every dig/stop decision
// untouched (sunk costs don't move the optimum). At these numbers the
// house edge under EXACT optimal play is ≈3.6% (pinned by the DP in tests).
export const PERMIT = 70;

// The wreck's relics. `size` fragments complete a relic; `pays` is the
// banked payout (in dig-costs) for a completed set. Order is protocol.
export const RELICS = [
  { key: 'coin',    name: 'Ship\'s Coin',     size: 2, pays: 2 },
  { key: 'sextant', name: 'Brass Sextant',    size: 3, pays: 7 },
  { key: 'figure',  name: 'The Figurehead',   size: 4, pays: 20 },
];
export const FRAGMENTS = RELICS.reduce((s, r) => s + r.size, 0); // 9 among 25

// ---------------------------------------------------------------- prng
function prng(seedHex) {
  const clean = String(seedHex).replace(/[^0-9a-fA-F]/g, '').padEnd(32, '7');
  let a = parseInt(clean.slice(0, 8), 16) | 0;
  let b = parseInt(clean.slice(8, 16), 16) | 0;
  let c = parseInt(clean.slice(16, 24), 16) | 0;
  let d = parseInt(clean.slice(24, 32), 16) | 0;
  return function next() {
    const t = b << 9; let r = b * 5; r = ((r << 7) | (r >>> 25)) * 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return ((r >>> 0) / 4294967296);
  };
}

// ---------------------------------------------------------------- state

// A fresh pool: nothing turned, every fragment still in the water.
export function newPool() {
  return {
    stonesLeft: STONES,
    // fragments not yet found, per relic key
    left: Object.fromEntries(RELICS.map((r) => [r.key, r.size])),
    found: Object.fromEntries(RELICS.map((r) => [r.key, 0])),
    digs: 0,
    banked: [],   // relic keys completed, in completion order
  };
}
export const fragmentsLeft = (pool) => Object.values(pool.left).reduce((a, b) => a + b, 0);

// The live odds the player is staring at — the heart of the stopping game.
export function hitChance(pool) {
  return pool.stonesLeft > 0 ? fragmentsLeft(pool) / pool.stonesLeft : 0;
}

// ---------------------------------------------------------------- the dig

// Turn one stone. The seed decides everything: whether this stone hides a
// fragment (hypergeometric draw over what remains) and, on a hit, WHICH
// relic's fragment surfaced (uniform over remaining fragments).
// Returns a NEW pool plus the outcome; never mutates the input.
export function dig(pool, seedHex) {
  if (pool.stonesLeft <= 0) throw new Error('dig: the pool is turned over');
  const rand = prng(seedHex);
  const F = fragmentsLeft(pool);
  const hit = rand() * pool.stonesLeft < F;
  const next = {
    ...pool,
    left: { ...pool.left }, found: { ...pool.found },
    banked: [...pool.banked],
    stonesLeft: pool.stonesLeft - 1,
    digs: pool.digs + 1,
  };
  if (!hit) return { pool: next, hit: false, relic: null, completed: null };
  // which fragment surfaced: uniform over the F remaining
  let pick = Math.floor(rand() * F);
  let relicKey = null;
  for (const r of RELICS) {
    if (pick < next.left[r.key]) { relicKey = r.key; break; }
    pick -= next.left[r.key];
  }
  next.left[relicKey] -= 1;
  next.found[relicKey] += 1;
  let completed = null;
  const spec = RELICS.find((r) => r.key === relicKey);
  if (next.found[relicKey] === spec.size) {
    completed = relicKey;
    next.banked.push(relicKey);
  }
  return { pool: next, hit: true, relic: relicKey, completed };
}

// ---------------------------------------------------------------- settling

// What a walk-away is worth right now: banked relics pay, spent digs don't
// come back. delta is against everything paid so far this expedition.
export function bankValue(pool) {
  const payout = pool.banked.reduce(
    (s, k) => s + RELICS.find((r) => r.key === k).pays * DIG_COST, 0);
  const spent = PERMIT + pool.digs * DIG_COST;
  return { payout, spent, delta: payout - spent };
}

// Replay a whole expedition from its seeds — the offline verifier.
// seeds[i] decided dig i. Returns the final pool and every step.
export function verifyExpedition(seeds) {
  let pool = newPool();
  const steps = [];
  for (const s of seeds) {
    const out = dig(pool, s);
    steps.push({ hit: out.hit, relic: out.relic, completed: out.completed });
    pool = out.pool;
  }
  return { pool, steps, ...bankValue(pool) };
}

// ---------------------------------------------------------------- strategy maths

// Exact expected value of the whole pool ("turn every stone"): every
// fragment is certainly found, so it's just all payouts minus all costs
// including the permit.
export function fullClearanceValue() {
  const pays = RELICS.reduce((s, r) => s + r.pays * DIG_COST, 0);
  return pays - STONES * DIG_COST - PERMIT;
}

// The marginal question the player faces every stone: the exact expected
// payout gain of ONE more dig, given the pool state. Used by tests to pin
// the edge, and by the UI to be honest about the water.
export function marginalDigEV(pool) {
  const F = fragmentsLeft(pool);
  if (pool.stonesLeft === 0 || F === 0) return -DIG_COST;
  const pHit = F / pool.stonesLeft;
  // expected completion payout of the surfaced fragment: a fragment of
  // relic r completes it only if it's the last one missing
  let completionEV = 0;
  for (const r of RELICS) {
    const l = pool.left[r.key];
    if (l === 0) continue;
    const pThisRelic = l / F;
    if (l === 1) completionEV += pThisRelic * r.pays * DIG_COST;
  }
  // fragments that don't complete a set pay nothing NOW but carry option
  // value; this function reports only the immediate, guaranteed part.
  return pHit * completionEV - DIG_COST;
}
