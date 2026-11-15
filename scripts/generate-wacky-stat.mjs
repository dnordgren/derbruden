#!/usr/bin/env node
// Wacky stat detector (PROTOTYPE, dry-run only).
//
// Finds ESPN-style "craziest stat of the week" candidates for one completed
// league week: a deterministic detector computes every fact and ranks it
// against league history (ESPN weekly data, 2018 on; pre-2018 exists only
// as season aggregates in stats.csv). A future LLM layer may rank/phrase
// these candidates, but it never supplies a fact — every number printed
// here comes out of the detector.
//
// This script NEVER posts anywhere. It prints candidates for editorial
// review. Posting (Discord webhook) is a separate, gated step.
//
// Usage:
//   node scripts/generate-wacky-stat.mjs [--season=YYYY] [--week=N] [--offline] [--max-rank=N] [--fresh]
//   node scripts/generate-wacky-stat.mjs --snapshot [--season=YYYY] [--week=N]
// Defaults: current season (Aug-Dec -> this year, else last year) and the
// last completed week of that season.
//
// Data comes cache-first from scripts/.wacky-cache/ (git-ignored), the
// pattern the relegation generator uses: season-<year>.json holds
// mTeam+mMatchupScore+mSettings, roster-<year>-<week>.json holds the
// scoring-period-scoped mRoster pull. Missing cache entries are fetched
// from ESPN (needs ESPN_S2/SWID in scripts/.env) unless --offline.
//
// The cache has no expiry, so a scheduled run passes --fresh: it drops
// ONLY the target season + target week cache files (season JSON, roster
// week, NFL day map) so they are re-pulled live. Finished weeks and
// historical seasons are immutable and stay cached forever.
// --snapshot instead saves the in-progress week's live games + rosters
// to snapshot-<season>-<week>.json (separate from the main cache, so a
// mid-game capture can never poison a later analysis run) and exits.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEAM_OWNERS } from './team-owners.js'
import { API_BASE, LEAGUE_ID_DEFAULT, authCookie, resolveConfig, fetchJson, defaultSeason } from './lib/espn.mjs'

export { defaultSeason }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, '.wacky-cache')
const ENV_FILE = path.join(__dirname, '.env')
const LEAGUE_ID = LEAGUE_ID_DEFAULT
const FIRST_HISTORY_SEASON = 2018
const BENCH_SLOT = 20
const IR_SLOT = 21

// Rarity floor: a candidate is only worth posting if it is genuinely
// rare. League-history detectors must rank 30th or better all-time
// (of ~570 games since 2018); the season-to-date share detector must be
// a top-3 share of the season. A quiet week prints no candidates rather
// than padding the list. Override with --max-rank=N.
export const MAX_HISTORY_RANK = 30
export const MAX_SEASON_RANK = 3

// ---------------------------------------------------------------------------
// ESPN payload extraction (pure; unit-tested)
// ---------------------------------------------------------------------------

// One decided regular-season game from a season payload's schedule.
// Undecided/future games (winner UNDECIDED, 0-0) and playoff-tier games
// are dropped so records match the site's regular-season convention.
export function extractWeeklyGames(league, season) {
  const games = []
  for (const m of league.schedule || []) {
    if (m.playoffTierType && m.playoffTierType !== 'NONE') continue
    if (m.winner !== 'HOME' && m.winner !== 'AWAY') continue
    if (!m.home || !m.away) continue
    const homePts = Number(m.home.totalPoints) || 0
    const awayPts = Number(m.away.totalPoints) || 0
    const homeWon = m.winner === 'HOME'
    games.push({
      season,
      week: m.matchupPeriodId,
      homeId: m.home.teamId,
      awayId: m.away.teamId,
      homePts,
      awayPts,
      winnerId: homeWon ? m.home.teamId : m.away.teamId,
      loserId: homeWon ? m.away.teamId : m.home.teamId,
      winnerPts: homeWon ? homePts : awayPts,
      loserPts: homeWon ? awayPts : homePts,
      margin: Math.abs(homePts - awayPts),
    })
  }
  return games
}

export function extractTeams(league) {
  const map = {}
  for (const t of league.teams || []) {
    map[t.id] = {
      id: t.id,
      name: t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`,
      owner: TEAM_OWNERS[t.id]?.owner || '?',
    }
  }
  return map
}

// Applied fantasy total for one scoring period, same convention as the
// sit/start generator. Falls back to the pool entry's appliedStatTotal,
// which is period-scoped because our roster pulls always pass
// scoringPeriodId.
export function weekScoreOf(player, week) {
  const split = (player.stats || []).find(
    s => s.statSourceId === 0 && s.statSplitTypeId === 1 && s.scoringPeriodId === week
  )
  if (split) return Number(split.appliedTotal) || 0
  return null
}

// Per-team player lines for one week from a scoring-period mRoster pull:
// starters (slot is not bench/IR) and bench, each with points and the
// starter slots the player is eligible to fill.
export function rosterWeek(rosterLeague, week) {
  const out = {}
  for (const t of rosterLeague.teams || []) {
    const starters = []
    const bench = []
    for (const e of t.roster?.entries || []) {
      const player = e.playerPoolEntry?.player
      if (!player) continue
      let points = weekScoreOf(player, week)
      if (points == null && Number.isFinite(Number(e.playerPoolEntry?.appliedStatTotal))) {
        points = Number(e.playerPoolEntry.appliedStatTotal)
      }
      if (points == null) continue
      const entry = {
        name: player.fullName || `Player ${e.playerId}`,
        points,
        lineupSlotId: e.lineupSlotId,
        elig: player.eligibleSlots || [],
        pos: player.defaultPositionId,
        proTeamId: player.proTeamId,
      }
      if (e.lineupSlotId === BENCH_SLOT || e.lineupSlotId === IR_SLOT) bench.push(entry)
      else starters.push(entry)
    }
    out[t.id] = { starters, bench }
  }
  return out
}

// ---------------------------------------------------------------------------
// History + ranking helpers (pure)
// ---------------------------------------------------------------------------

// All decided regular-season games strictly before the target week:
// every prior season in full, plus the target season's earlier weeks.
export function buildHistory(seasonGames, targetSeason, targetWeek) {
  const out = []
  for (const [season, games] of seasonGames) {
    for (const g of games) {
      if (season < targetSeason || (season === targetSeason && g.week < targetWeek)) out.push(g)
    }
  }
  return out.sort((a, b) => a.season - b.season || a.week - b.week)
}

// 1-based rank of `value` among `values` sorted descending (ties share the
// better rank), plus the most recent entry strictly greater than value.
export function rankDesc(entries, value, get) {
  let rank = 1
  let lastGreater = null
  for (const e of entries) {
    if (get(e) > value) {
      rank++
      if (
        !lastGreater ||
        e.season > lastGreater.season ||
        (e.season === lastGreater.season && e.week > lastGreater.week)
      ) {
        lastGreater = e
      }
    }
  }
  return { rank, total: entries.length, lastGreater }
}

export function rankAsc(entries, value, get) {
  const neg = entries.map(e => ({ ...e, __v: -get(e) }))
  return rankDesc(neg, -value, e => e.__v)
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

const fmt = n => Math.round(n * 100) / 100

function label(team) {
  return team ? `${team.owner} (${team.name})` : 'Unknown team'
}

// ---------------------------------------------------------------------------
// Detectors (pure). Each returns candidate objects:
// { type, score 0-100 (rarity), headline, facts }
// ---------------------------------------------------------------------------

export function detectBlowout(games, history, teams, maxRank = MAX_HISTORY_RANK) {
  let best = null
  for (const g of games) {
    const { rank, total, lastGreater } = rankDesc(history, g.margin, h => h.margin)
    if (!best || rank < best.facts.rank) {
      best = {
        type: 'blowout',
        score: Math.round(100 * (1 - (rank - 1) / Math.max(total, 1))),
        headline:
          `${label(teams[g.winnerId])} beat ${label(teams[g.loserId])} by ${fmt(g.margin)} points` +
          ` — the ${ordinal(rank)}-largest margin in league history (of ${total} games since ${FIRST_HISTORY_SEASON})` +
          (lastGreater
            ? `, and the largest since Week ${lastGreater.week}, ${lastGreater.season} (${fmt(lastGreater.margin)}).`
            : ' — the largest ever.'),
        facts: { rank, total, margin: fmt(g.margin), winnerPts: fmt(g.winnerPts), loserPts: fmt(g.loserPts) },
      }
    }
  }
  if (!best || best.facts.rank > maxRank) return []
  return [best]
}

export function detectHighScoreLoss(games, history, teams, maxRank = MAX_HISTORY_RANK) {
  let best = null
  for (const g of games) {
    const { rank, total, lastGreater } = rankDesc(history, g.loserPts, h => h.loserPts)
    if (!best || rank < best.facts.rank) {
      best = {
        type: 'high-score-loss',
        score: Math.round(100 * (1 - (rank - 1) / Math.max(total, 1))),
        headline:
          `${label(teams[g.loserId])} scored ${fmt(g.loserPts)} and LOST` +
          ` — the ${ordinal(rank)}-highest score by a losing team in league history (of ${total} losses since ${FIRST_HISTORY_SEASON})` +
          (lastGreater
            ? `, highest since Week ${lastGreater.week}, ${lastGreater.season} (${fmt(lastGreater.loserPts)}).`
            : ' — the highest ever.'),
        facts: { rank, total, loserPts: fmt(g.loserPts), winnerPts: fmt(g.winnerPts), margin: fmt(g.margin) },
      }
    }
  }
  if (!best || best.facts.rank > maxRank) return []
  return [best]
}

export function detectLowScoreWin(games, history, teams, maxRank = MAX_HISTORY_RANK) {
  let best = null
  for (const g of games) {
    const { rank, total } = rankAsc(history, g.winnerPts, h => h.winnerPts)
    if (!best || rank < best.facts.rank) {
      best = {
        type: 'low-score-win',
        score: Math.round(100 * (1 - (rank - 1) / Math.max(total, 1))),
        headline:
          `${label(teams[g.winnerId])} won with just ${fmt(g.winnerPts)} points` +
          ` — the ${ordinal(rank)}-lowest winning score in league history (of ${total} wins since ${FIRST_HISTORY_SEASON}).`,
        facts: { rank, total, winnerPts: fmt(g.winnerPts), loserPts: fmt(g.loserPts), margin: fmt(g.margin) },
      }
    }
  }
  if (!best || best.facts.rank > maxRank) return []
  return [best]
}

// Biggest single-player share of a team's total, ranked against the shares
// from earlier weeks of the same season (player history only exists in the
// per-week roster pulls, so the baseline is season-to-date).
export function detectTopPlayerShare(games, rosters, priorRosters, teams, maxSeasonRank = MAX_SEASON_RANK) {
  const shareOf = (teamId, roster) => {
    const r = roster?.[teamId]
    if (!r || !r.starters.length) return null
    const total = r.starters.reduce((s, p) => s + p.points, 0)
    if (total <= 0) return null
    const top = r.starters.reduce((a, b) => (b.points > a.points ? b : a))
    return { teamId, player: top.name, points: top.points, total, share: top.points / total }
  }
  const priorShares = []
  for (const roster of priorRosters) {
    for (const teamId of Object.keys(roster)) {
      const s = shareOf(Number(teamId), roster)
      if (s) priorShares.push(s.share)
    }
  }
  let best = null
  for (const g of games) {
    for (const teamId of [g.homeId, g.awayId]) {
      const s = shareOf(teamId, rosters)
      if (!s || s.share < 0.25) continue
      const rank = 1 + priorShares.filter(v => v > s.share).length
      const cand = {
        type: 'one-man-team',
        score: Math.round(100 * s.share),
        headline:
          `${s.player} scored ${fmt(s.points)} of ${label(teams[teamId])}'s ${fmt(s.total)} points` +
          ` (${Math.round(s.share * 100)}%) — the ${ordinal(rank)}-biggest single-player share of a team total this season.`,
        facts: { rank, share: fmt(s.share), playerPts: fmt(s.points), teamTotal: fmt(s.total) },
      }
      if (!best || cand.score > best.score) best = cand
    }
  }
  if (!best || best.facts.rank > maxSeasonRank) return []
  return [best]
}

// Closest game of the week, ranked against the smallest margins ever.
export function detectHeartbreaker(games, history, teams, maxRank = MAX_HISTORY_RANK) {
  let best = null
  for (const g of games) {
    const { rank, total } = rankAsc(history, g.margin, h => h.margin)
    if (!best || rank < best.facts.rank) {
      best = {
        type: 'heartbreaker',
        score: Math.round(100 * (1 - (rank - 1) / Math.max(total, 1))),
        headline:
          `${label(teams[g.winnerId])} edged ${label(teams[g.loserId])} by just ${fmt(g.margin)} points` +
          ` — the ${ordinal(rank)}-closest game in league history (of ${total} games since ${FIRST_HISTORY_SEASON}).`,
        facts: { rank, total, margin: fmt(g.margin), winnerPts: fmt(g.winnerPts), loserPts: fmt(g.loserPts) },
      }
    }
  }
  if (!best || best.facts.rank > maxRank) return []
  return [best]
}

// How many of the week's other teams a score would have beaten (all-play).
function wouldBeatCount(game, weekGames) {
  const scores = []
  for (const g of weekGames) {
    if (g.winnerId !== game.loserId) scores.push(g.winnerPts)
    if (g.loserId !== game.loserId) scores.push(g.loserPts)
  }
  return scores.filter(s => s < game.loserPts).length
}

// A loser who would have beaten almost everyone else that week. Fires
// only at 8+ of 9 — the event is its own rarity floor — and reports how
// often it has happened before.
export function detectHardLuck(games, history, teams) {
  const byWeek = new Map()
  for (const h of history) {
    const key = `${h.season}-${h.week}`
    if (!byWeek.has(key)) byWeek.set(key, [])
    byWeek.get(key).push(h)
  }
  const priorCounts = []
  for (const weekGames of byWeek.values()) {
    for (const h of weekGames) priorCounts.push(wouldBeatCount(h, weekGames))
  }
  let best = null
  for (const g of games) {
    const wouldBeat = wouldBeatCount(g, games)
    if (wouldBeat < 8) continue
    const prior = priorCounts.filter(c => c >= wouldBeat).length
    const cand = {
      type: 'hard-luck',
      score: Math.round(100 * (1 - prior / Math.max(history.length, 1))),
      headline:
        `${label(teams[g.loserId])} scored ${fmt(g.loserPts)} and lost — that score beats ${wouldBeat} of the other 9 teams this week.` +
        ` Only the ${ordinal(prior + 1)} time since ${FIRST_HISTORY_SEASON} a team has done that and still lost.`,
      facts: { wouldBeat, prior, total: history.length, loserPts: fmt(g.loserPts) },
    }
    if (!best || cand.score > best.score) best = cand
  }
  return best ? [best] : []
}

// A losing team that would have won with its single best bench swap:
// bench player outscores an eligible starter by more than the margin.
export function detectBenchFlip(games, rosters, teams) {
  let best = null
  for (const g of games) {
    const r = rosters?.[g.loserId]
    if (!r) continue
    for (const b of r.bench) {
      for (const s of r.starters) {
        if (!b.elig.includes(s.lineupSlotId)) continue
        const gain = b.points - s.points
        if (gain > g.margin && (!best || gain - g.margin > best.facts.netGain)) {
          best = {
            type: 'bench-flip',
            score: Math.min(99, Math.round(60 + (gain - g.margin))),
            headline:
              `${label(teams[g.loserId])} lost by ${fmt(g.margin)} with ${b.name}'s ${fmt(b.points)} points on the bench` +
              ` — starting him over ${s.name} (${fmt(s.points)}) flips the game by ${fmt(gain - g.margin)}.`,
            facts: { netGain: fmt(gain - g.margin), gain: fmt(gain), margin: fmt(g.margin) },
          }
        }
      }
    }
  }
  return best ? [best] : []
}

export const POS_NAMES = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' }

// Monday-night points for one team from its roster week: starters whose
// NFL team played on Monday, plus the biggest single contributor.
export function mondayLine(teamRoster, mondayTeamIds) {
  let total = 0
  let top = null
  for (const p of teamRoster?.starters || []) {
    if (!mondayTeamIds.has(Number(p.proTeamId))) continue
    total += p.points
    if (!top || p.points > top.points) top = { name: p.name, points: p.points }
  }
  return { total, top }
}

// Did the lead change hands on Monday night? Reconstructs the score
// going into MNF as final minus Monday starters' points. Returns the
// blown lead (pre-MNF margin of the team that ended up losing), or null.
export function mondayFlip(game, weekRosters, mondayTeamIds) {
  if (!weekRosters || !mondayTeamIds || mondayTeamIds.size === 0) return null
  const home = mondayLine(weekRosters[game.homeId], mondayTeamIds)
  const away = mondayLine(weekRosters[game.awayId], mondayTeamIds)
  const preHome = game.homePts - home.total
  const preAway = game.awayPts - away.total
  if (preHome === preAway) return null
  const preLeaderId = preHome > preAway ? game.homeId : game.awayId
  if (preLeaderId === game.winnerId) return null
  const winnerLine = game.winnerId === game.homeId ? home : away
  return {
    blownLead: Math.abs(preHome - preAway),
    winnerMondayPts: winnerLine.total,
    topScorer: winnerLine.top,
  }
}

export function detectMondayFlip(games, weekRosters, mondayTeamIds, historyFlips, teams, maxRank = MAX_HISTORY_RANK) {
  let best = null
  for (const g of games) {
    const flip = mondayFlip(g, weekRosters, mondayTeamIds)
    if (!flip) continue
    const rank = 1 + historyFlips.filter(h => h > flip.blownLead).length
    const cand = {
      type: 'monday-flip',
      score: Math.round(100 * (1 - (rank - 1) / Math.max(historyFlips.length, 1))),
      headline:
        `${label(teams[g.loserId])} led ${label(teams[g.winnerId])} by ${fmt(flip.blownLead)} going into Monday night and lost` +
        ` — the ${ordinal(rank)}-biggest blown Monday lead since ${FIRST_HISTORY_SEASON}` +
        ` (${label(teams[g.winnerId])} scored ${fmt(flip.winnerMondayPts)} on Monday` +
        (flip.topScorer ? `, led by ${flip.topScorer.name}'s ${fmt(flip.topScorer.points)}` : '') +
        ').',
      facts: { rank, totalFlips: historyFlips.length, blownLead: fmt(flip.blownLead) },
    }
    if (!best || cand.facts.rank < best.facts.rank) best = cand
  }
  if (!best || best.facts.rank > maxRank) return []
  return [best]
}

// Consecutive wins by the target game's winner over its loser, counting
// backwards through every prior meeting (history is chronological).
export function detectH2HStreak(games, history, teams) {
  let best = null
  for (const g of games) {
    const meetings = history.filter(
      h =>
        (h.winnerId === g.winnerId && h.loserId === g.loserId) || (h.winnerId === g.loserId && h.loserId === g.winnerId)
    )
    let streak = 1
    let lastLoss = null
    for (let i = meetings.length - 1; i >= 0; i--) {
      if (meetings[i].winnerId === g.winnerId) streak++
      else {
        lastLoss = meetings[i]
        break
      }
    }
    if (streak < 5) continue
    const cand = {
      type: 'h2h-streak',
      score: Math.min(95, 50 + streak * 5),
      headline:
        `${label(teams[g.winnerId])} has now beaten ${label(teams[g.loserId])} ${streak} straight times` +
        (lastLoss
          ? ` — the last loss in this matchup came in Week ${lastLoss.week}, ${lastLoss.season}.`
          : ` — and has not lost to them since ${FIRST_HISTORY_SEASON}.`),
      facts: { streak },
    }
    if (!best || streak > best.facts.streak) best = cand
  }
  return best ? [best] : []
}

// Best legal total for a set of lineup slots from a pool of players.
// Backtracking over slots (scarcest first) with an optimistic bound;
// a slot may be left empty for 0, matching the sit/start convention
// that an optimal lineup never starts a negative score.
export function optimalLineupTotal(entries, slots) {
  const pool = entries.filter(e => e.points > 0 || slots.some(s => e.elig.includes(s)))
  const order = slots
    .map(slot => ({ slot, options: pool.filter(p => p.elig.includes(slot)).length }))
    .sort((a, b) => a.options - b.options)
    .map(o => o.slot)
  const byPoints = [...pool].sort((a, b) => b.points - a.points)
  const used = new Set()
  let best = 0
  function dfs(idx, total) {
    if (idx === order.length) {
      if (total > best) best = total
      return
    }
    let bound = total
    let need = order.length - idx
    for (const p of byPoints) {
      if (need === 0) break
      if (!used.has(p)) {
        bound += Math.max(p.points, 0)
        need--
      }
    }
    if (bound <= best) return
    dfs(idx + 1, total)
    for (const p of pool) {
      if (used.has(p) || !p.elig.includes(order[idx])) continue
      used.add(p)
      dfs(idx + 1, total + p.points)
      used.delete(p)
    }
  }
  dfs(0, 0)
  return best
}

export function isPerfectWeek(teamRoster) {
  if (!teamRoster || !teamRoster.starters.length) return false
  const actual = teamRoster.starters.reduce((s, p) => s + p.points, 0)
  const slots = teamRoster.starters.map(p => p.lineupSlotId)
  const optimal = optimalLineupTotal([...teamRoster.starters, ...teamRoster.bench], slots)
  return optimal - actual < 0.005
}

export function detectPerfectWeek(games, rosters, teams, priorPerfectCount) {
  const out = []
  const seen = new Set()
  for (const g of games) {
    for (const teamId of [g.homeId, g.awayId]) {
      if (seen.has(teamId)) continue
      seen.add(teamId)
      if (!isPerfectWeek(rosters?.[teamId])) continue
      out.push({
        type: 'perfect-week',
        score: 92,
        headline:
          `${label(teams[teamId])} started a perfect lineup — every starter was the best legal option at his slot.` +
          ` Only the ${ordinal(priorPerfectCount + out.length + 1)} perfect week in the league since ${FIRST_HISTORY_SEASON}.`,
        facts: { priorPerfectCount },
      })
    }
  }
  return out
}

export function detectMilestones(games, history, teams) {
  const career = {}
  const bump = (teamId, g, wins, pf) => {
    const c = (career[teamId] ||= { wins: 0, losses: 0, pf: 0 })
    c.wins += wins
    c.losses += 1 - wins
    c.pf += pf
  }
  for (const h of history) {
    bump(h.winnerId, h, 1, h.winnerPts)
    bump(h.loserId, h, 0, h.loserPts)
  }
  const out = []
  for (const g of games) {
    for (const [teamId, won, pts] of [
      [g.winnerId, 1, g.winnerPts],
      [g.loserId, 0, g.loserPts],
    ]) {
      const before = { ...(career[teamId] || { wins: 0, losses: 0, pf: 0 }) }
      const after = { wins: before.wins + won, losses: before.losses + (1 - won), pf: before.pf + pts }
      const checks = [
        ['wins', 50, v => `career win #${v}`],
        ['pf', 2500, v => `${v.toLocaleString('en-US')} career points-for`],
        ['losses', 50, v => `career loss #${v}`],
      ]
      for (const [key, step, describe] of checks) {
        const crossed = Math.floor(after[key] / step) * step
        if (crossed > 0 && before[key] < crossed && after[key] >= crossed) {
          out.push({
            type: 'milestone',
            score: 70,
            headline: `${label(teams[teamId])} reached ${describe(crossed)} this week (now ${fmt(after[key])} total).`,
            facts: { kind: key, value: crossed },
          })
        }
      }
    }
  }
  return out
}

export function detectFutility(games, history, teams) {
  const log = {}
  for (const h of [...history, ...games].sort((a, b) => a.season - b.season || a.week - b.week)) {
    for (const [teamId, pts, won] of [
      [h.winnerId, h.winnerPts, true],
      [h.loserId, h.loserPts, false],
    ]) {
      ;(log[teamId] ||= []).push({ season: h.season, week: h.week, pts, won })
    }
  }
  const out = []
  const seen = new Set()
  for (const g of games) {
    for (const teamId of [g.homeId, g.awayId]) {
      if (seen.has(teamId)) continue
      seen.add(teamId)
      const entries = log[teamId] || []
      const last = entries[entries.length - 1]
      if (!last) continue
      let loseStreak = 0
      for (let i = entries.length - 1; i >= 0 && !entries[i].won; i--) loseStreak++
      let priorLoseStreak = 0
      for (let i = entries.length - 2; i >= 0 && !entries[i].won; i--) priorLoseStreak++
      if (!last.won && loseStreak >= 6) {
        out.push({
          type: 'futility',
          score: Math.min(90, 40 + loseStreak * 6),
          headline: `${label(teams[teamId])} has lost ${loseStreak} straight games.`,
          facts: { kind: 'losing-streak', streak: loseStreak },
        })
      } else if (last.won && priorLoseStreak >= 5) {
        out.push({
          type: 'futility',
          score: Math.min(90, 40 + priorLoseStreak * 6),
          headline: `${label(teams[teamId])} finally won, snapping a ${priorLoseStreak}-game losing streak.`,
          facts: { kind: 'streak-snapped', streak: priorLoseStreak },
        })
      }
      let subStreak = 0
      for (let i = entries.length - 1; i >= 0 && entries[i].pts < 100; i--) subStreak++
      if (subStreak >= 4) {
        out.push({
          type: 'futility',
          score: Math.min(88, 40 + subStreak * 8),
          headline: `${label(teams[teamId])} has now scored under 100 points in ${subStreak} straight games.`,
          facts: { kind: 'sub-100-streak', streak: subStreak },
        })
      }
    }
  }
  return out
}

// Best single-player game of the week by position, ranked against every
// starting player-week at that position in history.
export function detectPlayerRecord(games, rosters, playerHistory, teams, maxRank = MAX_HISTORY_RANK) {
  let best = null
  const seen = new Set()
  for (const g of games) {
    for (const teamId of [g.homeId, g.awayId]) {
      if (seen.has(teamId)) continue
      seen.add(teamId)
      for (const p of rosters?.[teamId]?.starters || []) {
        if (!POS_NAMES[p.pos]) continue
        const rank = 1 + playerHistory.filter(h => h.pos === p.pos && h.points > p.points).length
        const total = playerHistory.filter(h => h.pos === p.pos).length
        const cand = {
          type: 'player-record',
          score: Math.round(100 * (1 - (rank - 1) / Math.max(total, 1))),
          headline:
            `${p.name} scored ${fmt(p.points)} for ${label(teams[teamId])}` +
            ` — the ${ordinal(rank)}-biggest ${POS_NAMES[p.pos]} game since ${FIRST_HISTORY_SEASON} (of ${total}).`,
          facts: { rank, total, pos: POS_NAMES[p.pos], points: fmt(p.points) },
        }
        if (!best || rank < best.facts.rank) best = cand
      }
    }
  }
  if (!best || best.facts.rank > maxRank) return []
  return [best]
}

export function detectCandidates(ctx) {
  const { games, history, teams, rosters, priorRosters, maxRank = MAX_HISTORY_RANK } = ctx
  const all = [
    ...detectBlowout(games, history, teams, maxRank),
    ...detectHighScoreLoss(games, history, teams, maxRank),
    ...detectLowScoreWin(games, history, teams, maxRank),
    ...detectHeartbreaker(games, history, teams, maxRank),
    ...detectHardLuck(games, history, teams),
    ...detectMondayFlip(games, ctx.weekRosters, ctx.mondayTeamIds, ctx.historyFlips || [], teams, maxRank),
    ...detectH2HStreak(games, history, teams),
    ...detectPerfectWeek(games, rosters, teams, ctx.priorPerfectCount || 0),
    ...detectMilestones(games, history, teams),
    ...detectFutility(games, history, teams),
    ...detectPlayerRecord(games, rosters, ctx.playerHistory || [], teams, maxRank),
    ...detectTopPlayerShare(games, rosters, priorRosters, teams),
    ...detectBenchFlip(games, rosters, teams),
  ]
  return all.sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------------------
// Loading (cache-first, ESPN fallback)
// ---------------------------------------------------------------------------

async function loadJson(cacheName, url, offline) {
  const cachePath = path.join(CACHE_DIR, cacheName)
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  if (offline) throw new Error(`No cache for ${cacheName} and --offline was given`)
  const env = resolveConfig(ENV_FILE, ['ESPN_S2', 'SWID'])
  const data = await fetchJson(fetch, url, { headers: { Cookie: authCookie(env) } })
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(cachePath, JSON.stringify(data))
  return data
}

const seasonUrl = season =>
  `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mTeam&view=mMatchupScore&view=mSettings`
const rosterUrl = (season, week) =>
  `${API_BASE}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mRoster&scoringPeriodId=${week}`
const nflScoreboardUrl = (season, week) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`

// Roster weeks are cached slim: { byTeam: { <id>: { starters, bench } } },
// the exact shape rosterWeek() returns, so a 4 MB ESPN pull becomes a
// ~40 KB cache file. Legacy raw caches are converted on first read.
async function loadRosterWeek(season, week, offline) {
  const cacheName = `roster-${season}-${week}.json`
  const cachePath = path.join(CACHE_DIR, cacheName)
  if (fs.existsSync(cachePath)) {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (parsed.byTeam) return parsed.byTeam
    const byTeam = rosterWeek(parsed, week)
    fs.writeFileSync(cachePath, JSON.stringify({ byTeam }))
    return byTeam
  }
  if (offline) throw new Error(`No cache for ${cacheName} and --offline was given`)
  const env = resolveConfig(ENV_FILE, ['ESPN_S2', 'SWID'])
  const raw = await fetchJson(fetch, rosterUrl(season, week), { headers: { Cookie: authCookie(env) } })
  const byTeam = rosterWeek(raw, week)
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(cachePath, JSON.stringify({ byTeam }))
  return byTeam
}

// Which NFL teams played on Monday of a given week (Eastern), from the
// public ESPN NFL scoreboard. Cached slim as { days: { teamId: 'Mon' } }.
async function loadMondayTeamIds(season, week, offline) {
  const cacheName = `nfl-${season}-${week}.json`
  const cachePath = path.join(CACHE_DIR, cacheName)
  let days
  if (fs.existsSync(cachePath)) {
    days = JSON.parse(fs.readFileSync(cachePath, 'utf8')).days || {}
  } else {
    if (offline) throw new Error(`No cache for ${cacheName} and --offline was given`)
    const data = await fetchJson(fetch, nflScoreboardUrl(season, week))
    days = {}
    for (const ev of data.events || []) {
      const day = new Date(ev.date).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })
      for (const c of ev.competitions?.[0]?.competitors || []) days[c.team.id] = day
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify({ days }))
  }
  return new Set(
    Object.keys(days)
      .filter(id => days[id] === 'Mon')
      .map(Number)
  )
}

// The only cache files a --fresh / --snapshot run may drop. Two phases:
// before the league is loaded, the target season's JSON (week unknown
// yet); once the week is known, that week's roster + NFL day-map files.
// The week phase must NOT name the season file again — main() clears in
// two phases with a live re-fetch in between, and re-clearing the
// season file would delete the copy it just fetched, leaving the
// current season permanently uncached. Everything older is final and
// stays cached.
export function currentCacheFiles(season, week = null) {
  if (week == null) return [`season-${season}.json`]
  return [`roster-${season}-${week}.json`, `nfl-${season}-${week}.json`]
}

export function clearCurrentCache(season, week = null, dir = CACHE_DIR) {
  for (const name of currentCacheFiles(season, week)) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

// The in-progress week for a snapshot: ESPN's own current scoring
// period. (lastCompletedWeek + 1 is wrong the moment any game of the
// current week is final — e.g. the Thursday game.)
export function snapshotWeek(league) {
  if (league.scoringPeriodId) return league.scoringPeriodId
  return lastCompletedWeek(league) + 1
}

export function lastCompletedWeek(league) {
  let last = 0
  for (const g of extractWeeklyGames(league, 0)) last = Math.max(last, g.week)
  return last
}

export function parseArgs(argv) {
  const args = { season: null, week: null, offline: false, fresh: false, snapshot: false, maxRank: MAX_HISTORY_RANK }
  for (const arg of argv) {
    if (arg === '--offline') args.offline = true
    else if (arg === '--fresh') args.fresh = true
    else if (arg === '--snapshot') args.snapshot = true
    else if (arg.startsWith('--season=')) args.season = Number(arg.split('=')[1])
    else if (arg.startsWith('--week=')) args.week = Number(arg.split('=')[1])
    else if (arg.startsWith('--max-rank=')) args.maxRank = Number(arg.split('=')[1])
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const season = args.season ?? defaultSeason()
  // A fresh or snapshot run must see live data for the target season:
  // drop its league JSON first, then (once the week is known) that
  // week's roster + NFL day-map files. History is never dropped.
  if (args.fresh || args.snapshot) clearCurrentCache(season)
  const targetLeague = await loadJson(`season-${season}.json`, seasonUrl(season), args.offline)
  const week = args.week ?? (args.snapshot ? snapshotWeek(targetLeague) : lastCompletedWeek(targetLeague))
  if (!week) throw new Error(`No completed week found for ${season}`)
  if (args.fresh || args.snapshot) clearCurrentCache(season, week)

  if (args.snapshot) {
    // Raw schedule entries for the week, decided or not — extractWeeklyGames
    // only returns decided games, which is exactly what a live snapshot
    // must NOT filter to.
    const games = (targetLeague.schedule || [])
      .filter(
        m => m.matchupPeriodId === week && (!m.playoffTierType || m.playoffTierType === 'NONE') && m.home && m.away
      )
      .map(m => ({
        week: m.matchupPeriodId,
        homeId: m.home.teamId,
        awayId: m.away.teamId,
        homePts: Number(m.home.totalPoints) || 0,
        awayPts: Number(m.away.totalPoints) || 0,
        winner: m.winner || 'UNDECIDED',
      }))
    if (!games.length) throw new Error(`No games found for ${season} Week ${week} to snapshot`)
    const rosters = await loadRosterWeek(season, week, args.offline)
    let mondayTeamIds = new Set()
    try {
      mondayTeamIds = await loadMondayTeamIds(season, week, args.offline)
    } catch {
      // snapshot still useful without the Monday map
    }
    const snapshot = {
      capturedAt: new Date().toISOString(),
      season,
      week,
      games,
      rosters,
      mondayTeamIds: [...mondayTeamIds],
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const out = path.join(CACHE_DIR, `snapshot-${season}-${week}.json`)
    fs.writeFileSync(out, JSON.stringify(snapshot))
    console.log(`Snapshot saved: ${out} (${games.length} games, captured ${snapshot.capturedAt})`)
    return
  }

  const seasonGames = new Map()
  for (let y = FIRST_HISTORY_SEASON; y <= season; y++) {
    const league = y === season ? targetLeague : await loadJson(`season-${y}.json`, seasonUrl(y), args.offline)
    seasonGames.set(y, extractWeeklyGames(league, y))
  }
  const history = buildHistory(seasonGames, season, week)
  const games = seasonGames.get(season).filter(g => g.week === week)
  const teams = extractTeams(targetLeague)

  // Roster weeks for the target week (required) and every history week
  // (best effort: a missing cache shrinks the player-level baselines,
  // it does not block the score-level detectors).
  const rosters = await loadRosterWeek(season, week, args.offline)
  const weekRosters = new Map([[`${season}|${week}`, rosters]])
  const weeksWanted = new Map()
  for (const [y, gs] of seasonGames) {
    for (const g of gs) {
      if (y < season || (y === season && g.week < week)) weeksWanted.set(`${y}|${g.week}`, [y, g.week])
    }
  }
  for (const [key, [y, w]] of weeksWanted) {
    try {
      weekRosters.set(key, await loadRosterWeek(y, w, args.offline))
    } catch {
      // baseline gap only
    }
  }
  const priorRosters = []
  for (let w = 1; w < week; w++) {
    const r = weekRosters.get(`${season}|${w}`)
    if (r) priorRosters.push(r)
  }

  // Monday-flip history, player-week history, and the perfect-week count
  // all come from the same history roster pass.
  const historyFlips = []
  const playerHistory = []
  let priorPerfectCount = 0
  const historyByWeek = new Map()
  for (const h of history) {
    const key = `${h.season}|${h.week}`
    if (!historyByWeek.has(key)) historyByWeek.set(key, [])
    historyByWeek.get(key).push(h)
  }
  for (const [key, weekGames] of historyByWeek) {
    const [y, w] = key.split('|').map(Number)
    const wr = weekRosters.get(key)
    if (!wr) continue
    let monday = new Set()
    try {
      monday = await loadMondayTeamIds(y, w, args.offline)
    } catch {
      // no Monday baseline for this week
    }
    for (const h of weekGames) {
      const flip = mondayFlip(h, wr, monday)
      if (flip) historyFlips.push(flip.blownLead)
    }
    for (const teamRoster of Object.values(wr)) {
      for (const p of teamRoster.starters) playerHistory.push({ pos: p.pos, points: p.points })
      if (isPerfectWeek(teamRoster)) priorPerfectCount++
    }
  }
  let mondayTeamIds = new Set()
  try {
    mondayTeamIds = await loadMondayTeamIds(season, week, args.offline)
  } catch {
    // Monday detector stays silent without the NFL schedule
  }

  const candidates = detectCandidates({
    games,
    history,
    teams,
    rosters,
    priorRosters,
    maxRank: args.maxRank,
    weekRosters: rosters,
    mondayTeamIds,
    historyFlips,
    priorPerfectCount,
    playerHistory,
  })
  console.log(`Wacky stat candidates — Der Bruden ${season} Week ${week} (DRY RUN, nothing posted)`)
  console.log(`History baseline: ${history.length} decided regular-season games, ${FIRST_HISTORY_SEASON}-${season}`)
  if (!candidates.length) console.log('No candidates cleared the detector thresholds this week.')
  candidates.forEach((c, i) => {
    console.log(`\n${i + 1}. [${c.type}] rarity ${c.score}/100`)
    console.log(`   ${c.headline}`)
  })
  console.log('\nJSON:')
  console.log(JSON.stringify({ season, week, candidates }, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
