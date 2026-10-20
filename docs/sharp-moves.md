# Sharp-move classifier (Jev)

Once a minute the local server reads a model-free confluence of order-flow readings and, with a key, asks [TypeSafe's Jev](https://docs.typesafe.ai/api) whether a sharp price move is about to happen, both from the order-flow ideas @karlbooklover posts. Every minute is logged with the readings behind it; `npm run sharp:eval` later measures both against what price did next. The page can sound an alert for Jev's assessment (Sounds panel, "Sharp move (Jev)"), off by default.

Jev is a System One model: `POST https://api.typesafe.ai/v1/systemone` with a `state` and typed `questions` (Noul: yes probability, Score: a rubric level, Choice) returns typed answers with probabilities.

## Concepts

Taken from 562 of Karl's posts (2026-09-05 to 2026-10-12). Each is one feature in code and one yes/no question for Jev. Status ids are paraphrased sources: `https://x.com/karlbooklover/status/<id>`.

| Id | Karl's rule (paraphrased) | Sources |
| --- | --- | --- |
| `spotPerpDivergence` | Spot and perp CVD diverging often causes a squeeze; trapped perps follow spot in a violent reaction | [2108945149350809697](https://x.com/karlbooklover/status/2108945149350809697), [2098135287410880902](https://x.com/karlbooklover/status/2098135287410880902), [2109328756821123079](https://x.com/karlbooklover/status/2109328756821123079) |
| `binanceSpotLeads` | Binance spot leads; a new spot-CVD high while price flushes is not bearish | [2108714883172708856](https://x.com/karlbooklover/status/2108714883172708856), [2108602845163585617](https://x.com/karlbooklover/status/2108602845163585617), [2109660655468884170](https://x.com/karlbooklover/status/2109660655468884170) |
| `priceCvdDivergence` | Price/CVD divergence points to the explosive scenario; price not reacting to spot CVD | [2102457147527434260](https://x.com/karlbooklover/status/2102457147527434260), [2109323383930265807](https://x.com/karlbooklover/status/2109323383930265807) |
| `liquidityPulled` | Market makers stop replenishing, a liquidity void, price rips; ask liquidity rising before a drop; books flipping bid to ask trap buyers | [2107819961783558235](https://x.com/karlbooklover/status/2107819961783558235), [2108621424445264321](https://x.com/karlbooklover/status/2108621424445264321), [2099927300330365216](https://x.com/karlbooklover/status/2099927300330365216), [2107125271954337912](https://x.com/karlbooklover/status/2107125271954337912) |
| `trackerFlip` | The Liquidity Tracker flipping to green preceded a bounce | [2107530779958145191](https://x.com/karlbooklover/status/2107530779958145191), [2109055139130556579](https://x.com/karlbooklover/status/2109055139130556579), [2096306788769374227](https://x.com/karlbooklover/status/2096306788769374227) |
| `bookImbalance` | Aggregated book 12 % more bids; a skewed book | [2109660655468884170](https://x.com/karlbooklover/status/2109660655468884170), [2109372570088685896](https://x.com/karlbooklover/status/2109372570088685896) |
| `highlight` | The Highlight feature often catches pivots or breakouts; never a standalone signal | [2109439801195896866](https://x.com/karlbooklover/status/2109439801195896866) |
| `liquidationCascade` | Liquidation cascades at local pivots; forced sellers absorbed by spot bids | [2099933915116916899](https://x.com/karlbooklover/status/2099933915116916899), [2107652260087947316](https://x.com/karlbooklover/status/2107652260087947316) |
| `leverageBuild` | New leveraged positions into a move are fuel for the next forced wave; OI rising into a flush | [2098079731681739088](https://x.com/karlbooklover/status/2098079731681739088), [2097325665343193236](https://x.com/karlbooklover/status/2097325665343193236) |
| `whaleVsRetail` | Retail CVD up while whale CVD down, whales are moving the market; orders of $1M and up net buyers | [2107615727192555865](https://x.com/karlbooklover/status/2107615727192555865), [2108035908473602109](https://x.com/karlbooklover/status/2108035908473602109), [2104622368760987690](https://x.com/karlbooklover/status/2104622368760987690) |
| `slicer` | A slicer just sent the spot CVD: steady automated buying | [2096700081176981862](https://x.com/karlbooklover/status/2096700081176981862), [2109014173569192409](https://x.com/karlbooklover/status/2109014173569192409) |

Absorption ([2108239290912453073](https://x.com/karlbooklover/status/2108239290912453073), [2101021343638544533](https://x.com/karlbooklover/status/2101021343638544533)) is left out: its server query is asynchronous and per threshold, and a partial signal is worse than none.

## Features (`src/shared/sharp/features.ts`)

`sharpFeatures(inputs)` is pure. Its inputs are what the server records for the coin of the chart's own market (`markInstrumentId`'s base; every spot and perpetual market of it): per-minute taker flow, depth minutes, liquidations, open interest and whale sums. Returns are log returns in %; CVD per minute is buys minus sells summed over a group's instruments (a minute nothing was recorded is 0).

A **z-score** compares a window with the same-length, non-overlapping windows of the previous 24 h, using only windows that start after the group's first recorded minute; fewer than 12 such windows give `null`. So the 15-minute z-scores appear after about 3 h of recording and the 60-minute ones after about 12 h; the full day only makes them steadier.

| Concept | Values (`null`: no data) |
| --- | --- |
| `spotPerpDivergence` | `spotZ15`, `perpZ15`, `spotZ60`, `perpZ60`; `spotPerpOpposite` is true when, at 15 or at 60 minutes, the signs differ and both \|z\| are at least 1 |
| `binanceSpotLeads` | `binanceSpotZ60`, `ret60`; `binanceLeads` when \|z\| is at least 1 and its sign is opposite to the return's |
| `priceCvdDivergence` | `aggZ15` (spot plus perp), `retZ15` (15-minute return against the day's); `priceCvdOpposite` as above |
| `liquidityPulled` | `bidChangePct`, `askChangePct`: resting USD within 1 % of each book's own middle, the last recorded minute against the mean of minutes 10 to 5 before it |
| `trackerFlip` | `ltNow`, `lt30`: the Liquidity Tracker's (bid - ask) / (bid + ask) at the 25 bp half-life, now and 30 minutes ago; `ltFlipped` when the sign changed |
| `bookImbalance` | `imb1pct` within 1 %, and `imbPctile6h`, its percentile among the last 6 h of minutes |
| `highlight` | `volSigma`, `deltaSigma`: the page's Highlights rule (`shared/anomaly.ts`, 2 sigma over 72 minutes) on the last minute's gross taker volume and absolute net delta |
| `liquidationCascade` | `liqLong5`, `liqShort5`, `liqLong15`, `liqShort15` (USD), `liqZ5`: the 5-minute total against the day's non-overlapping 5-minute totals |
| `leverageBuild` | `oi15Pct`, `oi60Pct` of the reference perpetual (Binance's, else the first), with `ret60` |
| `whaleVsRetail` | `whaleNet60`: net USD of orders in the third size band (about $1M on BTC) over 60 minutes; `whaleOpposite` when its sign differs from all taker flow's |
| `slicer` | `slicerShare`: of the last 30 minutes of Binance spot net delta, the share within 0.5 to 1.5 times the median (and so of its sign) |

Alongside the numbers each concept gets one English sentence (`words`), e.g. "Spot taker flow over the last 15 minutes is +2.3σ (buying) while perpetual flow is -1.6σ (selling)." A concept with no data yet has no sentence, and is not asked.

## Questions (`src/shared/sharp/jev.ts`)

`SHARP_QUESTIONS` holds one Noul per concept (for example `spotPerpDivergence`: "Are spot and perpetual traders taking opposite sides strongly enough that the perpetual side could be squeezed?"), then:

- `sharpMove`, a Score from 0 to 4 ("Very unlikely" to "Very likely"): "How likely is a sharp price move (several times the usual 15-minute range) in the next 15 minutes?"
- `direction`, a Choice of `up` or `down`: "If price moves sharply in the next 15 minutes, which way?"

The state is `{ market, time_utc, price, readings (the sentences), numbers (the values), notes }`. A response is checked field by field; anything off throws `jev: malformed answer`, a non-2xx status `jev: HTTP <status>`.

## Running it

- The monitor starts with the local server (`npm run dev`) and runs 15 s past each minute, never overlapping itself. Every minute it reads the confluence (below); with `TYPESAFE_API_KEY` set it also asks Jev, and after an HTTP 429 asks Jev only every 5 minutes until one succeeds (the confluence is still read). Without a key `/api/v2/sharp` answers `enabled: false` and the reason. Errors are logged once an hour per message and shown in `lastError`.
- `GET /api/v2/sharp` returns `{ enabled, reason?, lastError?, coin, verdicts, confluence }`: Jev's last 120 assessments and the last 120 confluence readings, oldest first.
- Every minute is appended as `{ features, confluence, verdict? }` to `<data dir>/sharp-log.jsonl` (`data/runtime/` for `npm run dev`); `verdict` is absent when Jev was not asked or did not answer. Past 50 MiB it is renamed `sharp-log.1.jsonl` (replacing an older one). It is not in `history.sqlite`, which has a hard size budget.
- The page's Sounds panel has "Sharp move likely" and a minimum score (2 to 4, default 3). It polls the server every 30 s, ignores what it finds first, and sounds three notes (rising for up, falling for down) for an assessment that is new, under 90 s old, at or above the minimum score and with Jev's confidence in the score at least 0.5; ten-minute cool-down.

## Measuring it

`npm run sharp:eval -- [--log <path>] [--horizon 15] [--k 3]`

A row is labelled from the later rows of the same coin: the largest absolute log excursion within `horizon` minutes, against `k` times the standard deviation of 15-minute returns over the previous 24 h of rows (fewer than 48 rows before it: unlabelled; a log that ends before the horizon: unlabelled). It prints the base rate and, for Jev's score, each concept's yes probability and a baseline (the largest of \|`spotZ15`\|, \|`perpZ15`\|, \|`retZ15`\|, `volSigma`, `liqZ5`, nulls as 0), the ROC AUC (rank based) and the Brier score of the probabilities, the direction hit rate on sharp rows, and precision and recall at score 3 or more.

The script also scores the confluence (below), recomputed from each row's logged values, so minutes logged before it existed count: the AUC of its |score| against sharpness, its direction on sharp rows, and its calls as trades held to the horizon (mean return signed by the call, beside every row's mean absolute return).

Results are recorded in `Research_Findings.md` (git-ignored, as AGENTS.md requires for research), not here. Run this after at least 48 h of log.

## Casebook (`npm run sharp:episodes`)

`npm run sharp:episodes -- [--data data/runtime] [--out Research_Results/sharp-episodes] [--ref binance:BTCUSDT] [--coin BTC]` (`scripts/sharp-episodes.mts`) keeps the recordings past their week and collects every volatile move, up or down, with what came before, during and after it. The output folder is git-ignored research output.

- **Archive.** Each whole UTC day not kept yet is written to `minutes/<day>.jsonl.gz`, a line a minute: the reference perpetual's 1-minute candle; each market's taker buy and sell USD and last price; every liquidation; each book's resting USD in bands of 0-10, 10-25, 25-50, 50-100 and 100-200 bp from its own middle; all perpetual and all spot books on a fixed $50 grid within 2 % of the close; each perpetual's open interest; and the `sharp-log.jsonl` row made as the minute closed. The recordings keep seven days and the log rotates, so this has to run at least every six days; a day once kept is never rewritten.
- **Moves.** A minute is sharp when the reference perpetual closes 2 sigma of 15-minute returns away within the next 15 minutes (`label` of `sharp:eval` on the candles' closes, sigma over the 24 h before). Sharp minutes of one direction at most 15 minutes apart are one move, measured by its swing on the candles, from the high a fall starts at (the low a rise starts at) to where it ends; same-direction moves whose swings overlap are one. Strong: one of its minutes reached 3 sigma, the evaluation's default.
- **Files**, rebuilt from every kept day and today's recordings on each run: `episodes.jsonl` (each move: times, prices, size in % and sigma, the 10 and 30 minutes before its start, what happened during it and in the 30 minutes after, and each model's reading 10 minutes before, at, 3 minutes into and at the end of it); `alarms.jsonl` (each model's loud readings, score 3 or more of 4 or a confluence call, and whether a move started within 15 minutes, was under way, had just ended, or none followed); `cases/<start>-<up|down>.txt` (each move minute by minute from 30 minutes before its start to 30 after its end, with the readings made as each minute closed); `summary.txt`.
- **A move's start is a turning point found afterwards**: the minutes before it ran the other way by construction. Its `before` windows describe the case and predict nothing. The summary's tables of what tells a move is coming (AUC for touching 2 sigma either way within 15 minutes) and which way (the share of minutes that touched one side first where the reading pointed to that side, with a 95 % range treating each hour as one cluster) therefore use every minute, each reading as it was known when the minute closed.

## Side by side: SubQ Snap (`SUBQ_API_KEY`)

[SubQ Snap](https://docs.subq.ai/markdown/endpoints/decisions-api.md) (`subq-snap-preview`, public preview, $0.05 per million input tokens) serves the same `/v1/systemone` contract as Jev with a 384K-token context and up to four images. With `SUBQ_API_KEY` set the watch asks it every minute, in shadow, in three arms beside Jev, each with the same questions:

| Arm | State | Tests |
| --- | --- | --- |
| `subq` | The same as Jev's | The model alone |
| `subqHistory` | Plus `history_csv`: 24 h of raw minutes (`sharpSeries`: price, spot and perpetual net flow, gross volume, resting USD within 1 % for the last 6 h, liquidations) | Whether the raw history helps; it is over Jev's 32K-token state limit |
| `subqImage` | Plus one PNG (`server/v2/sharp-image.mts`): the last 2 h of resting liquidity, 5 bp rows around the price, bids green, asks red, brightness over three decades below the largest cell, the price as a white line | Whether seeing the book helps |

The arms run in parallel with Jev, each with its own error and five-minute back-off after a 429. Their verdicts are logged under `arms` in the minute's row and returned under `arms` by `/api/v2/sharp`. `sharp:eval` scores every model on the minutes it answered, with latency and input tokens, then all of them on the minutes they all answered (the fair comparison), leaving out a model with no answer over the last 24 h of labelled minutes. `SUBQ_ARMS` (comma-separated) chooses the arms asked: unset, all three; `SUBQ_ARMS=subq,subqImage` pauses the history arm, which is then not asked, its history not built, and it is absent from the log and `/api/v2/sharp` (with the image arm left out the heatmap is not built either; a name that is no arm is reported at start). Start the server with both keys from the macOS keychain:

```bash
TYPESAFE_API_KEY="$(security find-generic-password -s typesafeai-api-key -w)" SUBQ_API_KEY="$(security find-generic-password -s subq-api-key -w)" npm run dev
```

## Confluence (`src/shared/sharp/confluence.ts`)

A directional reading of the same values without a model, made every minute whether or not Jev is asked. The concepts are grouped into three families of independent data; each family casts one vote in [-1, 1] (the sum of its parts, clamped), so readings that move together never count twice:

| Family | Parts (vote) |
| --- | --- |
| `flow` | Spot taker flow leads: `spotZ15` (else `spotZ60`) from 1σ, full at 3σ; without a spot side, `binanceSpotZ60` at three quarters. Whales against everyone (`whaleOpposite`): ±0.5 their way. A Binance spot slicer (`slicerShare` ≥ 0.6): ±0.25 with Binance spot |
| `book` | One side within 1 % pulled by 30 % or more in 5 to 10 minutes while the other held (no worse than -10 %): ±0.5 toward the pulled side (bids pulled: down). The tracker flipped: ±0.5 to its new side. The imbalance at the 90th / 10th percentile of 6 h: ±0.5 with the heavy side |
| `positioning` | A liquidation burst (`liqZ5` ≥ 2) over two-thirds longs: +0.5 (forced sellers at a pivot), shorts: -0.5. Open interest up 0.3 % or more in 15 minutes into a move: ±0.5 against the move |

A family whose vote is under 0.25 does not vote. `direction` is the sign of the sum, `score` its mean over the three families. A **call** needs at least two families with `direction`, none against it, and a trigger this minute: a highlighted bar (`volSigma` or `deltaSigma` ≥ 2), a liquidation burst, `spotPerpOpposite` or `priceCvdOpposite`. Agreement without a trigger is a drift, not a call.

The rules come from Karl's posts (Concepts above) and are hypotheses until `sharp:eval` says otherwise. The minute grid is the recorder's: this is a one-minute reading over a 15-minute horizon, not a sub-second signal.
