# Divisional relegation backtest

Generated 2026-11-14 from ESPN league 794521 data. Window: 2019-2025 (seeded from 2018-2024).

Weekly scores held fixed; pairings replaced by a 2x5 divisional template (intra x2, cross x1). Seeding: prior-year All-Play % (primary) or prior-year W-L (sensitivity).

Playoff variants under the simulated schedule: **straight** = top 6 by W-L (PF tiebreak); **winners+record** = both division winners in, next 4 by W-L; **winners+PF** = division winners in, next 4 by points for.

## League-wide averages, actual vs simulated (All-Play seeding)

| Metric | Actual | Relegation sim |
|---|---|---|
| Median margin | 21.66 | 22.48 |
| Mean margin | 25.23 | 25.36 |
| Games within 10 pts | 25.7% | 26.59% |
| Games within 20 pts | 46.53% | 46.1% |
| Final standings spread (wins, 1st to 10th) | 5.86 | 6.57 |

## Simulated margins by game type (all seasons pooled)

| Game type | Games | Median margin | ≤10 pts |
|---|---|---|---|
| Division A (prior top 5) | 140 | 22.63 (avg of season medians) | 27.9% |
| Division B (prior bottom 5) | 140 | 25.81 (avg of season medians) | 25.7% |
| Cross-division | 185 | 21.48 (avg of season medians) | 26.5% |

Top-6 PF teams missing the simulated playoffs, by qualification variant (avg per season): straight 1, winners+record 1, winners+PF 0.29.

## Per season

| Season | Actual median margin | Sim median margin | Actual ≤10pt | Sim ≤10pt | Sim playoff field (straight) vs actual | Top-6 PF teams missing sim playoffs (straight) |
|---|---|---|---|---|---|---|
| 2019 | 27.6 | 26.22 | 18.5% | 21.5% | 4/6 same | 1 |
| 2020 | 21.82 | 22.44 | 23.1% | 29.2% | 5/6 same | 1 |
| 2021 (14 wks) | 16.24 | 19.14 | 40% | 30% | 4/6 same | 2 |
| 2022 (14 wks) | 22.66 | 20.78 | 22.9% | 30% | 5/6 same | 1 |
| 2023 | 22.4 | 27.22 | 20% | 20% | 5/6 same | 0 |
| 2024 | 17.14 | 20 | 30.8% | 24.6% | 5/6 same | 0 |
| 2025 | 23.74 | 21.58 | 24.6% | 30.8% | 4/6 same | 2 |

## Divisions by season (All-Play seeding)

- **2019** A: GM, IK, CR, DN, JO · B: DM, AN, ZS, AR, JH (New franchise(s) JH seeded last (no 2018 season).)
- **2020** A: AN, DN, CR, JH, DM · B: GM, AR, IK, JO, ZS
- **2021** A: AN, JO, CR, JH, GM · B: DM, IK, ZS, DN, AR
- **2022** A: CR, AR, IK, DN, JH · B: GM, DM, ZS, JO, AN
- **2023** A: CR, GM, JH, DM, AN · B: DN, IK, AR, JO, ZS
- **2024** A: CR, AN, DM, JO, GM · B: JH, IK, ZS, AR, DN
- **2025** A: GM, ZS, JO, JH, AN · B: DN, DM, CR, AR, IK

## Notes and limits

- Scores are held fixed: the model assumes a team scores the same points regardless of opponent. Lineup, waiver, and trade behavior would shift somewhat under a different schedule and playoff race.
- 2021 and 2022 were 14-week regular seasons. Week 14 is modeled as one extra cross-division round (each A slot replays the same-index B slot); treat those two seasons as directional.
- All-Play seeding is schedule-independent, so re-seeding recursively from simulated seasons changes nothing under the primary metric. The W-L-seeded sensitivity pass is in relegation.json (`record` key per season).
- Pre-2018 seasons exist only as aggregates in stats.csv (no weekly scores) and cannot be re-scheduled.
