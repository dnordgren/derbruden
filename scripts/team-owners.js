// ESPN team id -> owner code and page. Team ids are stable franchise slots,
// but verify against the league each August and adjust after the draft.
// Cross-check: 2025 W-L-PF per team matched stats.csv season 25 exactly.
export const TEAM_OWNERS = {
  1: { owner: 'GM', page: 'gm.html' },
  2: { owner: 'DM', page: 'dm.html' },
  4: { owner: 'AN', page: 'an.html' },
  5: { owner: 'AR', page: 'ar.html' },
  7: { owner: 'CR', page: 'cr.html' },
  8: { owner: 'DN', page: 'dn.html' },
  9: { owner: 'JO', page: 'jo.html' },
  10: { owner: 'ZS', page: 'zs.html' },
  11: { owner: 'IK', page: 'ik.html' },
  12: { owner: 'JH', page: 'jh.html' },
}
