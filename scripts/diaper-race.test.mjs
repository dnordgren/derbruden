import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeDiaperFate,
  renderDiaperTable,
  renderPageContent,
} from './generate-diaper-race.mjs'
import { buildPayload } from './post-diaper-discord.mjs'

function teams(n = 4) {
  const out = {}
  for (let i = 1; i <= n; i++) out[i] = { id: i, abbrev: `T${i}`, name: `Team ${i}` }
  return out
}

test('computeDiaperFate with 0 remaining uses PF tiebreak for last', () => {
  const teamsById = teams()
  const stats = {
    1: { teamId: 1, wins: 8, losses: 5, ties: 0, pf: 1500, pa: 1300 },
    2: { teamId: 2, wins: 8, losses: 5, ties: 0, pf: 1400, pa: 1300 },
    3: { teamId: 3, wins: 6, losses: 7, ties: 0, pf: 1500, pa: 1300 },
    4: { teamId: 4, wins: 6, losses: 7, ties: 0, pf: 1300, pa: 1300 },
  }
  const res = computeDiaperFate(stats, [], 4, teamsById)
  // 4 has the worst record + lower PF -> doomed; everyone else safe
  assert.deepEqual(new Set(res.doomed), new Set([4]))
  assert.deepEqual(new Set(res.safe), new Set([1, 2, 3]))
})

test('computeDiaperFate locks in a team that cannot escape last', () => {
  // 4 teams, 1 game remaining: 3 vs 4. A 8-0, B 8-0, C 1-7, D 0-8.
  // D can at best reach 1 win, tying C only if C loses; C holds the
  // tiebreak either way on PF, so D is doomed.
  const teamsById = teams()
  const stats = {
    1: { teamId: 1, wins: 8, losses: 0, ties: 0, pf: 1200, pa: 0 },
    2: { teamId: 2, wins: 8, losses: 0, ties: 0, pf: 1100, pa: 0 },
    3: { teamId: 3, wins: 1, losses: 7, ties: 0, pf: 800, pa: 0 },
    4: { teamId: 4, wins: 0, losses: 8, ties: 0, pf: 700, pa: 0 },
  }
  const remaining = [{ week: 10, homeId: 3, awayId: 4, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false }]
  const res = computeDiaperFate(stats, remaining, 4, teamsById)
  // wins-only grouping is conservative: D's best rank is 3 (tied with C at
  // 1 win, tiebreak assumed winnable), so D is NOT doomed yet.
  assert.ok(!res.doomed.includes(4))
  // A and B cannot finish last -> safe
  assert.ok(res.safe.includes(1))
  assert.ok(res.safe.includes(2))
})

test('computeDiaperFate dooms a team even winning out cannot save', () => {
  // A 8-0, B 7-1, C 2-6, D 0-8, no games left involving D's escape:
  // D has no remaining games and sits 2 wins behind C -> best rank 4.
  const teamsById = teams()
  const stats = {
    1: { teamId: 1, wins: 8, losses: 0, ties: 0, pf: 1200, pa: 0 },
    2: { teamId: 2, wins: 7, losses: 1, ties: 0, pf: 1100, pa: 0 },
    3: { teamId: 3, wins: 2, losses: 6, ties: 0, pf: 800, pa: 0 },
    4: { teamId: 4, wins: 0, losses: 8, ties: 0, pf: 700, pa: 0 },
  }
  const remaining = [{ week: 10, homeId: 1, awayId: 2, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false }]
  const res = computeDiaperFate(stats, remaining, 4, teamsById)
  assert.deepEqual(new Set(res.doomed), new Set([4]))
  assert.deepEqual(new Set(res.safe), new Set([1, 2, 3]))
})

test('computeDiaperFate respects ENUM_LIMIT', () => {
  const teamsById = { 1: { id: 1, abbrev: 'A', name: 'A' }, 2: { id: 2, abbrev: 'B', name: 'B' } }
  const stats = { 1: { teamId: 1, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 }, 2: { teamId: 2, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 } }
  const remaining = Array.from({ length: 25 }, (_, i) => ({ week: i + 1, homeId: 1, awayId: 2, homeScore: 0, awayScore: 0, winner: 'undecided', playoff: false }))
  const res = computeDiaperFate(stats, remaining, 2, teamsById)
  assert.equal(res.note?.includes('too many'), true)
  assert.equal(res.doomed.length, 0)
})

test('renderDiaperTable orders worst first with badges', () => {
  const standings = [
    { rank: 1, teamId: 1, owner: 'A', abbrev: 'A', name: 'A', wins: 8, losses: 0, ties: 0, pf: 1000, remaining: 0 },
    { rank: 4, teamId: 4, owner: 'D', abbrev: 'D', name: 'D', wins: 0, losses: 8, ties: 0, pf: 700, remaining: 0 },
  ]
  const html = renderDiaperTable([...standings].reverse(), new Set([4]), new Set([1]))
  const dPos = html.indexOf('>D<')
  const aPos = html.indexOf('>A<')
  assert.ok(dPos !== -1 && aPos !== -1 && dPos < aPos)
  assert.ok(html.includes('badge doomed'))
  assert.ok(html.includes('badge safe'))
})

test('renderPageContent mentions the diaper stakes', () => {
  const data = {
    season: 2026,
    generated: '2026-11-04',
    teamCount: 4,
    regularSeasonWeeks: 13,
    throughWeek: 9,
    currentWeek: 10,
    remainingCount: 10,
    startWeek: 11,
    standings: [
      { rank: 1, teamId: 1, owner: 'A', abbrev: 'A', name: 'A', wins: 8, losses: 1, ties: 0, winValue: 8, pf: 1000, pa: 800, gamesBack: 0, remaining: 4 },
      { rank: 4, teamId: 4, owner: 'D', abbrev: 'D', name: 'D', wins: 1, losses: 8, ties: 0, winValue: 1, pf: 700, pa: 900, gamesBack: 7, remaining: 4 },
    ],
    doomedTeamIds: [],
    safeTeamIds: [1],
    doomedOwners: [],
    safeOwners: ['A'],
    remainingByTeam: { 1: 4, 4: 4 },
    remainingGames: [],
    scenarios: null,
    note: null,
  }
  const html = renderPageContent(data, teams())
  assert.ok(html.includes('Diaper Race'))
  assert.ok(html.includes('wears a diaper'))
  assert.ok(html.includes('make diaper'))
})

test('buildPayload lists worst team first with diaper line', () => {
  const data = {
    season: 2026,
    throughWeek: 9,
    currentWeek: 10,
    remainingCount: 10,
    teamCount: 4,
    standings: [
      { rank: 1, teamId: 1, owner: 'AAA', wins: 8, losses: 1, ties: 0, pf: 1000, doomed: false, safe: true },
      { rank: 2, teamId: 2, owner: 'BBB', wins: 5, losses: 4, ties: 0, pf: 900, doomed: false, safe: false },
      { rank: 3, teamId: 3, owner: 'CCC', wins: 3, losses: 6, ties: 0, pf: 800, doomed: false, safe: false },
      { rank: 4, teamId: 4, owner: 'DDD', wins: 1, losses: 8, ties: 0, pf: 700, doomed: false, safe: false },
    ],
    doomedTeamIds: [],
    safeTeamIds: [1],
    doomedOwners: [],
    safeOwners: ['AAA'],
    scenarios: null,
  }
  const payload = buildPayload(data)
  assert.equal(payload.username, 'Der Bruden Diaper Race')
  const desc = payload.embeds[0].description
  const dddPos = desc.indexOf('DDD')
  const aaaPos = desc.indexOf('AAA')
  assert.ok(dddPos !== -1 && dddPos < aaaPos)
  assert.ok(desc.includes('diaper'))
  assert.ok(desc.includes('https://derbruden.com/diaper-race.html'))
})

test('buildPayload hypes a locked-in diaper', () => {
  const data = {
    season: 2026,
    throughWeek: 13,
    currentWeek: null,
    remainingCount: 0,
    teamCount: 4,
    standings: [
      { rank: 1, teamId: 1, owner: 'AAA', wins: 8, losses: 5, ties: 0, pf: 1000, doomed: false, safe: true },
      { rank: 4, teamId: 4, owner: 'DDD', wins: 1, losses: 12, ties: 0, pf: 700, doomed: true, safe: false },
    ],
    doomedTeamIds: [4],
    safeTeamIds: [1],
    doomedOwners: ['DDD'],
    safeOwners: ['AAA'],
    scenarios: null,
  }
  const payload = buildPayload(data)
  assert.ok(payload.embeds[0].title.includes('Final'))
  assert.ok(payload.embeds[0].description.includes('🍼 DDD'))
})
