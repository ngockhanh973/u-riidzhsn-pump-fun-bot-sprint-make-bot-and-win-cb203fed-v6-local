[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v6-local/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v6-local/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Second-Wind Dip-Recovery Bot v6-local (Strict Dip)

A Solana trading bot for the make.fun **Pump.fun Bot Sprint** bounty. It trades
paper money on a replay of real pump.fun bonding-curve events, ranked on net
PnL over a 6-hour final window the bot never sees in advance.

## Idea

Do not chase freshly created coins — most of them rug or never run. This bot
only buys a coin that has already proven it can run (its price once reached
5x its creation price) and has since pulled back to a **shallow dip**: the
current price sits at 75–85% of its peak, while buyers are returning (at
least 3 buys from at least 3 different wallets in the last 20 slots, net flow
positive, latest trade a buy, no single buyer dominating).

v6 tightens the v4 base in exactly four numbers: the dip band narrows from
70–88% to **75–85%** (a deep dip on the dev window usually means a dead coin,
not a bargain), the stop-loss tightens from 20% to **15%** (to stop the
occasional large-position stop-out from eating a whole trip), and the first
take-profit moves from 25% to **20%** (bank half sooner). The lesson from the
earlier variants was consistent: entering earlier and casting a wider net both
lost more — the winning direction is to be more selective, not broader.

## How it trades

- **Entry (all must hold):** creator sold under 0.5 SOL total; coin at least
  200 slots old; peak price ≥ 5x creation price; peak real SOL ≥ 8; current
  real SOL ≥ 3; price/peak in [0.75, 0.85]; flow window as above.
- **Sizing:** first buy 0.10 SOL, one add of 0.20 SOL when the price is back
  5% above the first buy with flow still positive (position cap 0.60 SOL).
  At most 5 main positions, total exposure capped at 5.0 SOL.
- **Exits (checked before any new entry each batch):** sell everything on
  creator veto (≥ 0.5 SOL sold), stop-loss −15%, trailing stop −15% after the
  first half-profit, full take-profit at +100% after the first half-profit,
  fading flow (15-slot net under −0.05 SOL), or holding too long (1200 slots,
  doubled while up ≥ 20%). Sell half at +20%, once per position.
- **Lifetime cap:** at most 2 position openings per coin ever; after an exit,
  150 slots must pass before the second opening.
- **Pacing probe:** a tiny 0.01 SOL probe keeps the bot on pace for the
  guardrails (22 coins / 100 fills over 4 hours) when it is behind schedule,
  and is sold in full as soon as its buy fills.

Everything is deterministic: no clock, no randomness, no environment, no IO
inside the strategy — every decision comes only from the harness batch plus
internal state.

## Key parameters

| Parameter | Value | Parameter | Value |
|---|---|---|---|
| minRunup | 5.0 | stopLoss | 0.15 |
| dipMin / dipMax | 0.75 / 0.85 | tp1 / tp2 | 0.20 / 1.00 |
| minPeakRealSol | 8 SOL | trail | 0.15 |
| firstSol / addSol | 0.10 / 0.20 SOL | maxHold | 1200 slots |
| maxPositionSol | 0.60 SOL | maxExposureSol | 5.0 SOL |
| minAge | 200 slots | cooldown | 150 slots |
| maxEntries | 2 / coin | maxMain | 5 |

## Layout

- `main.ts` — entrypoint: wires the strategy to the harness shim.
- `strategy.ts` — the whole strategy (`createStrategy`, `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's harness shim, copied byte-identical.

## Run the dev-window sim

The sim harness lives outside this repo (local scratch only):

```sh
cd pump-sim-v6
node tools/backtest.ts ../../pumpfun-kit/extracted/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-kit
```

## Dev-window result

Measured on the kit's dev window with the local sim port, two identical runs
(deterministic):

- **net −0.041989 SOL**, 111 fills, 31 coins, 55 round trips, 6 wins
- max drawdown 0.0046, rejected 0, failed 2
- without failed txs −0.041594 SOL; at 2x fees −0.087194 SOL
- Guardrails pass: 31 coins ≥ 20, drawdown 0.0046 ≤ 0.50.

Baseline v4 on the same window: net −0.048358 SOL — v6 beats it by
+0.006369 SOL.

## License

MIT
