// Second-Wind Dip-Recovery Bot v6-local ("Strict Dip") — entrypoint.
//
// Runs the v6 strategy (shallow-dip entries at 75-85% of peak, 15% stop,
// 20% first take-profit) on the pump.fun replay harness. All trading logic
// lives in strategy.ts; this file only wires it to the harness shim.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
  onDone(state) {
    console.error(`done cash=${state.cash} positions=${state.positions.size} curves=${state.curves.size}`);
  },
});
