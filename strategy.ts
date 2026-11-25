// Second-Wind Dip-Recovery Bot v6-local ("Strict Dip").
//
// Idea: never chase a freshly created coin. Only buy a coin that has already
// proven it can run (price once 5x its creation price) and is now pulling back
// to a SHALLOW dip (75-85% of its peak) while buyers are coming back. A deep
// dip on the dev window usually means a dead coin, so v6 buys only the shallow
// band, cuts losses tighter (15%) and takes the first half-profit sooner (20%).
// The creator may take a small profit, but once the creator has sold 0.5 SOL
// in total the coin is vetoed forever.
//
// v6 is the v4 parameter set with exactly four changes: dipMin 0.70 -> 0.75,
// dipMax 0.88 -> 0.85, stopLoss 0.20 -> 0.15, tp1 0.25 -> 0.20. Everything
// else (entry filters, sizing, exits, pacing probe) is the v4 base.
//
// Deterministic: no clock, no randomness, no environment, no IO. Every
// decision comes only from the batch the harness sends plus this state.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  minRunup: number;
  minPeakRealSol: number;
  firstSol: number;
  addSol: number;
  maxPositionSol: number;
  maxExposureSol: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  trail: number;
  maxHold: number;
  minAge: number;
  flowWindow: number;
  minFlowSol: number;
  minFlowBuyers: number;
  lastMustBeBuy: boolean;
  maxBuyerShare: number;
  dipMax: number;
  dipMin: number;
  minRealSol: number;
  addStep: number;
  minBuySol: number;
  buySlipBps: number;
  fadeWindow: number;
  fadeNetSol: number;
  holdIfUp: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  creatorSellVetoSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunup: 5.0,
  minPeakRealSol: 8,
  firstSol: 0.1,
  addSol: 0.2,
  maxPositionSol: 0.6,
  maxExposureSol: 5.0,
  stopLoss: 0.15,
  tp1: 0.2,
  tp2: 1.0,
  trail: 0.15,
  maxHold: 1200,
  minAge: 200,
  flowWindow: 20,
  minFlowSol: 0.02,
  minFlowBuyers: 3,
  lastMustBeBuy: true,
  maxBuyerShare: 0.5,
  dipMax: 0.85,
  dipMin: 0.75,
  minRealSol: 3,
  addStep: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  fadeWindow: 15,
  fadeNetSol: 0.05,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  creatorSellVetoSol: 0.5,
  targetCoins: 22,
  targetFills: 100,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS_PER_SOL = 1_000_000_000n;
const FEE_BPS = 125n;
const SELL_SLIP_BPS = 10000;

interface TradeRec {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface CoinBook {
  mint: string;
  born: number | null;
  creator: string | null;
  startPx: number;
  topPx: number;
  topRq: number;
  makerSold: number;
  trades: TradeRec[];
  complete: boolean;
  entriesUsed: number;
  lastExitSlot: number | null;
  active: boolean;
  firstPx: number;
  added: boolean;
  tp1Done: boolean;
  best: bigint;
  openSlot: number;
}

type SentKind = 'first' | 'add' | 'tp1' | 'sell-all' | 'probe-buy' | 'probe-sell';

interface FlowStat {
  buys: number;
  buyers: number;
  buySol: number;
  sellSol: number;
  net: number;
  lastIsBuy: boolean;
  topShare: number;
}

function solLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

function bookFor(books: Map<string, CoinBook>, mint: string): CoinBook {
  let b = books.get(mint);
  if (b === undefined) {
    b = {
      mint,
      born: null,
      creator: null,
      startPx: 0,
      topPx: 0,
      topRq: 0,
      makerSold: 0,
      trades: [],
      complete: false,
      entriesUsed: 0,
      lastExitSlot: null,
      active: false,
      firstPx: 0,
      added: false,
      tp1Done: false,
      best: 0n,
      openSlot: 0,
    };
    books.set(mint, b);
  }
  return b;
}

export function createStrategy(p: Params) {
  const books = new Map<string, CoinBook>();
  const sent = new Map<string, { mint: string; kind: SentKind }>();
  const everFilled = new Set<string>();
  let totalFills = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let probeActive = false;
  let probeHeldMint: string | null = null;

  function priceOf(state: BotState, mint: string): number {
    const c = state.curves.get(mint);
    if (c === undefined) return 0;
    if (c.virtual_token_reserves === 0n) return 0;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  }

  function realSolOf(state: BotState, mint: string): number {
    const c = state.curves.get(mint);
    if (c === undefined) return 0;
    return Number(c.real_quote_reserves) / 1e9;
  }

  // Net value of a holding: mark minus the 1.25% curve fees minus one tx fee.
  function netValue(state: BotState, mint: string, tokens: bigint): bigint {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n || tokens <= 0n) return 0n;
    const gross = (tokens * c.virtual_quote_reserves) / c.virtual_token_reserves;
    const fee = (gross * FEE_BPS) / 10000n;
    const net = gross - fee - state.txFeeLamports();
    return net > 0n ? net : 0n;
  }

  function flowStat(b: CoinBook, slot: number, window: number): FlowStat {
    let buys = 0;
    let buySol = 0;
    let sellSol = 0;
    let lastIsBuy = false;
    const buyers = new Map<string, number>();
    let seen = 0;
    for (const t of b.trades) {
      if (t.slot <= slot - window) continue;
      seen++;
      if (t.buy) {
        buys++;
        buySol += t.sol;
        buyers.set(t.user, (buyers.get(t.user) ?? 0) + t.sol);
      } else {
        sellSol += t.sol;
      }
      lastIsBuy = t.buy;
    }
    let top = 0;
    for (const v of buyers.values()) if (v > top) top = v;
    return {
      buys,
      buyers: buyers.size,
      buySol,
      sellSol,
      net: buySol - sellSol,
      lastIsBuy: seen > 0 && lastIsBuy,
      topShare: buySol > 0 ? top / buySol : 1,
    };
  }

  function hasPending(state: BotState, mint: string, side?: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) {
      if (po.order.mint !== mint) continue;
      if (side === undefined || po.order.side === side) return true;
    }
    return false;
  }

  function closeBook(b: CoinBook, slot: number): void {
    b.active = false;
    b.added = false;
    b.tp1Done = false;
    b.best = 0n;
    b.lastExitSlot = slot;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const decidedSell = new Set<string>();
    const decidedBuy = new Set<string>();
    let cashLeft = state.freeCashLamports();
    const txFee = state.txFeeLamports();
    let exposure = 0n;
    for (const pos of state.positions.values()) exposure += pos.cost_lamports;
    for (const po of state.pending.values()) {
      if (po.order.side === 'buy') exposure += BigInt(po.order.quote_lamports);
    }
    const slot = batch.slot;

    const pushBuy = (mint: string, kind: SentKind, wantLamports: bigint, capByPosition: bigint | null): boolean => {
      let amount = wantLamports;
      const maxBuy = state.maxBuyLamports(mint);
      if (maxBuy < amount) amount = maxBuy;
      if (capByPosition !== null && capByPosition < amount) amount = capByPosition;
      const room = solLamports(p.maxExposureSol) - exposure;
      if (room < amount) amount = room;
      const cashRoom = cashLeft - txFee;
      if (cashRoom < amount) amount = cashRoom;
      if (amount < solLamports(p.minBuySol) || amount <= 0n) return false;
      const id = state.clientId();
      sent.set(id, { mint, kind });
      orders.push({ side: 'buy', client_id: id, mint, quote_lamports: amount.toString(), max_slippage_bps: p.buySlipBps });
      cashLeft -= amount + txFee;
      exposure += amount;
      decidedBuy.add(mint);
      return true;
    };

    const pushSell = (mint: string, kind: SentKind, tokens: bigint): void => {
      if (tokens <= 0n || decidedSell.has(mint)) return;
      const id = state.clientId();
      sent.set(id, { mint, kind });
      orders.push({ side: 'sell', client_id: id, mint, token_amount: tokens.toString(), max_slippage_bps: SELL_SLIP_BPS });
      cashLeft -= txFee;
      decidedSell.add(mint);
    };

    // ---- 1. Fold this batch's fills into the books. -------------------------
    for (const f of batch.fills) {
      const info = sent.get(f.client_id);
      if (info !== undefined) sent.delete(f.client_id);
      const b = books.get(f.mint);
      if (f.status === 'filled') {
        totalFills++;
        everFilled.add(f.mint);
        if (b === undefined) continue;
        if (info !== undefined) {
          if (info.kind === 'first') {
            b.entriesUsed += 1;
            b.active = true;
            b.openSlot = f.slot;
            b.firstPx = priceOf(state, f.mint);
            b.added = false;
            b.tp1Done = false;
            b.best = 0n;
          } else if (info.kind === 'add') {
            b.added = true;
          } else if (info.kind === 'tp1') {
            // Half-profit taken: the trailing peak now measures the tokens
            // still held, reset on the fill (never when the order was sent,
            // so a rejected TP1 cannot corrupt the trail).
            b.tp1Done = true;
            const pos = state.positions.get(f.mint);
            b.best = pos !== undefined ? netValue(state, f.mint, pos.token_amount) : 0n;
          } else if (info.kind === 'sell-all') {
            if (!state.positions.has(f.mint)) closeBook(b, f.slot);
          } else if (info.kind === 'probe-buy') {
            probeHeldMint = f.mint;
          } else if (info.kind === 'probe-sell') {
            probeActive = false;
            probeHeldMint = null;
          }
        }
        if (f.client_id.startsWith('_')) {
          // Harness close (complete / flatten / writeoff): position is gone.
          if (!state.positions.has(f.mint)) {
            closeBook(b, f.slot);
            if (probeHeldMint === f.mint) {
              probeHeldMint = null;
              probeActive = false;
            }
          }
        }
      } else {
        // Rejected or failed: a probe buy that never filled frees the probe
        // slot; a rejected TP1 leaves tp1Done false and the trail untouched.
        if (info !== undefined && info.kind === 'probe-buy') probeActive = false;
      }
    }

    // A position that vanished from state with no order in flight is closed
    // internally, and its exit time is recorded for the cooldown.
    for (const b of books.values()) {
      if (b.active && !state.positions.has(b.mint) && !hasPending(state, b.mint)) {
        closeBook(b, slot);
      }
    }
    if (probeHeldMint !== null && !state.positions.has(probeHeldMint) && !hasPending(state, probeHeldMint)) {
      probeHeldMint = null;
      probeActive = false;
    }

    // ---- 2. Fold this batch's events into the books. ------------------------
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const b = bookFor(books, e.mint);
        b.born = e.slot;
        b.creator = e.creator;
        const vt = BigInt(e.virtual_token_reserves);
        b.startPx = vt === 0n ? 0 : Number(e.virtual_quote_reserves) / Number(vt);
        if (b.topPx < b.startPx) b.topPx = b.startPx;
      } else if (e.event === 'TradeEvent') {
        const b = bookFor(books, e.mint);
        const vt = BigInt(e.virtual_token_reserves);
        const px = vt === 0n ? 0 : Number(e.virtual_quote_reserves) / Number(vt);
        if (px > b.topPx) b.topPx = px;
        const rq = Number(e.real_quote_reserves) / 1e9;
        if (rq > b.topRq) b.topRq = rq;
        const sol = Number(e.sol_amount) / 1e9;
        if (!e.is_buy && b.creator !== null && e.user === b.creator) b.makerSold += sol;
        b.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
      } else if (e.event === 'CompleteEvent') {
        bookFor(books, e.mint).complete = true;
      }
    }

    // ---- 3. Prune trade history older than the horizon. ---------------------
    const horizon = Math.max(p.flowWindow, p.fadeWindow) + 40;
    for (const b of books.values()) {
      if (b.trades.length === 0) continue;
      let cut = 0;
      while (cut < b.trades.length && b.trades[cut]!.slot <= slot - horizon) cut++;
      if (cut > 0) b.trades.splice(0, cut);
    }

    // ---- 4. Exits first, before any new entry in this batch. ---------------
    for (const [mint, pos] of state.positions) {
      const b = books.get(mint);
      if (b === undefined) continue;
      if (decidedSell.has(mint) || hasPending(state, mint, 'sell')) continue;
      if (probeHeldMint === mint) {
        pushSell(mint, 'probe-sell', pos.token_amount);
        continue;
      }
      if (!b.active) continue;
      const value = netValue(state, mint, pos.token_amount);
      const cost = pos.cost_lamports;
      const stopLine = (cost * BigInt(Math.round((1 - p.stopLoss) * 10000))) / 10000n;
      const fade = flowStat(b, slot, p.fadeWindow);
      const age = slot - b.openSlot;
      const upLine = (cost * BigInt(Math.round((1 + p.holdIfUp) * 10000))) / 10000n;
      const holdLimit = value >= upLine ? p.maxHold * 2 : p.maxHold;
      let exitAll = false;
      if (b.makerSold >= p.creatorSellVetoSol) exitAll = true;
      else if (value < stopLine) exitAll = true;
      else if (b.tp1Done && value < (b.best * BigInt(Math.round((1 - p.trail) * 10000))) / 10000n) exitAll = true;
      else if (b.tp1Done && value >= (cost * BigInt(Math.round((1 + p.tp2) * 10000))) / 10000n) exitAll = true;
      else if (fade.net < -p.fadeNetSol) exitAll = true;
      else if (age > holdLimit) exitAll = true;
      if (exitAll) {
        pushSell(mint, 'sell-all', pos.token_amount);
        continue;
      }
      // Track the trailing peak while the position lives.
      if (value > b.best) b.best = value;
      if (!b.tp1Done && value >= (cost * BigInt(Math.round((1 + p.tp1) * 10000))) / 10000n) {
        pushSell(mint, 'tp1', pos.token_amount / 2n);
      }
    }

    // ---- 5. Adds to open positions, then fresh entries. ----------------------
    let openMain = state.committedPositionCount();
    for (const b of books.values()) {
      const mint = b.mint;
      if (b.complete || decidedBuy.has(mint) || hasPending(state, mint)) continue;
      const pos = state.positions.get(mint);
      if (pos !== undefined && b.active && !b.added) {
        // One add only: price back above the first buy by 5%, flow still
        // positive, curve still liquid, room left under the position cap.
        const px = priceOf(state, mint);
        const flow = flowStat(b, slot, p.flowWindow);
        if (
          b.firstPx > 0 &&
          px >= b.firstPx * (1 + p.addStep) &&
          flow.net >= p.minFlowSol &&
          realSolOf(state, mint) >= p.minRealSol &&
          pos.cost_lamports < solLamports(p.maxPositionSol - p.minBuySol)
        ) {
          const room = solLamports(p.maxPositionSol) - pos.cost_lamports;
          pushBuy(mint, 'add', solLamports(p.addSol), room);
        }
        continue;
      }
      if (pos !== undefined) continue;
      if (b.born === null) continue;
      // Lifetime cap: at most maxEntries position openings per coin, ever.
      // The 150-slot cooldown only opens the second opening.
      if (b.entriesUsed >= p.maxEntries) continue;
      if (b.entriesUsed > 0 && b.lastExitSlot !== null && slot - b.lastExitSlot < p.cooldown) continue;
      if (openMain + decidedBuy.size >= p.maxMain) continue;
      if (b.makerSold >= p.creatorSellVetoSol) continue;
      if (slot - b.born < p.minAge) continue;
      if (b.startPx <= 0 || b.topPx < p.minRunup * b.startPx) continue;
      if (b.topRq < p.minPeakRealSol) continue;
      if (realSolOf(state, mint) < p.minRealSol) continue;
      const px = priceOf(state, mint);
      if (b.topPx <= 0) continue;
      const ratio = px / b.topPx;
      if (ratio < p.dipMin || ratio > p.dipMax) continue;
      const flow = flowStat(b, slot, p.flowWindow);
      if (flow.buys < p.minFlowBuyers) continue;
      if (flow.buyers < p.minFlowBuyers) continue;
      if (flow.net < p.minFlowSol) continue;
      if (p.lastMustBeBuy && !flow.lastIsBuy) continue;
      if (flow.topShare > p.maxBuyerShare) continue;
      if (pushBuy(mint, 'first', solLamports(p.firstSol), solLamports(p.maxPositionSol))) {
        openMain++;
      }
    }

    // ---- 6. Pacing probe: keep the guardrails fed, nothing more. ------------
    // Fill counts include sell fills, not buys only. A coin that has already
    // been probed may be probed again; only a coin with a probe in flight is
    // off limits, and only when coins (not fills) are short must the coin
    // never have matched before.
    if (!probeActive && firstBlockTime !== null && lastBlockTime !== null) {
      const progress = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
      const coinsShort = everFilled.size < Math.ceil(p.targetCoins * progress);
      const fillsShort = totalFills < Math.ceil(p.targetFills * progress);
      if ((coinsShort || fillsShort) && openMain + decidedBuy.size < p.maxMain) {
        const bps = state.hello.caps.max_order_bps_of_real_reserve;
        const liquidSol = p.probeSol * (10000 / bps) * 1.5;
        for (const e of batch.events) {
          if (e.event !== 'TradeEvent') continue;
          const mint = e.mint;
          const b = books.get(mint);
          if (b === undefined || b.complete) continue;
          if (decidedBuy.has(mint) || hasPending(state, mint)) continue;
          if (state.positions.has(mint)) continue;
          if (realSolOf(state, mint) < liquidSol) continue;
          if (coinsShort && everFilled.has(mint)) continue;
          if (pushBuy(mint, 'probe-buy', solLamports(p.probeSol), null)) {
            probeActive = true;
          }
          break;
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
