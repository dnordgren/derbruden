;(function () {
  'use strict'
  var dataEl = document.getElementById('luck-data')
  if (!dataEl) return
  var data
  try {
    data = JSON.parse(dataEl.textContent)
  } catch (e) {
    return
  }
  var perSeason = data.perSeason || {}
  var allPlayWrap = document.getElementById('allplay-table-wrap')
  var luckWrap = document.getElementById('luck-table-wrap')
  if (!perSeason || !Object.keys(perSeason).length) return

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function ownerLink(owner) {
    var pages = {
      GM: 'gm.html',
      DM: 'dm.html',
      AN: 'an.html',
      AR: 'ar.html',
      CR: 'cr.html',
      DN: 'dn.html',
      JO: 'jo.html',
      ZS: 'zs.html',
      IK: 'ik.html',
      JH: 'jh.html',
    }
    return pages[owner] ? '<a href="./' + pages[owner] + '">' + escapeHtml(owner) + '</a>' : escapeHtml(owner)
  }
  function fmt(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1)
  }
  function allPlayVerdict(row) {
    var d = row.delta
    if (d >= 2) return 'Benefited from schedule'
    if (d >= 1) return 'Slightly lucky schedule'
    if (d <= -2) return 'Hurt by schedule'
    if (d <= -1) return 'Tough schedule'
    return 'As expected'
  }

  function renderAllPlayTable(rows) {
    if (!rows || !rows.length) return '<p class="section-note">No regular-season games for this season.</p>'
    var body = rows
      .map(function (r) {
        return (
          '<tr>' +
          '<td class="number">' +
          r.allPlayRank +
          '</td>' +
          '<td class="owner">' +
          ownerLink(r.owner) +
          '</td>' +
          '<td>' +
          escapeHtml(r.team) +
          '</td>' +
          '<td class="number">' +
          r.actualW +
          '-' +
          r.actualL +
          (r.actualT ? '-' + r.actualT : '') +
          '</td>' +
          '<td class="number">' +
          fmt(r.pf) +
          '</td>' +
          '<td class="number">' +
          r.allPlayW +
          '-' +
          r.allPlayL +
          (r.allPlayT ? '-' + r.allPlayT : '') +
          '</td>' +
          '<td class="number">' +
          (r.allPlayPct * 100).toFixed(1) +
          '%</td>' +
          '<td class="number">' +
          (r.delta > 0 ? '+' + fmt(r.delta) : fmt(r.delta)) +
          '</td>' +
          '<td class="detail">' +
          escapeHtml(allPlayVerdict(r)) +
          '</td>' +
          '</tr>'
        )
      })
      .join('\n')
    return (
      '<div class="table-container"><table class="stats-table">' +
      '<thead><tr>' +
      '<th scope="col" class="number">AP Rank</th>' +
      '<th scope="col">Owner</th>' +
      '<th scope="col">Team</th>' +
      '<th scope="col" class="number">Record</th>' +
      '<th scope="col" class="number">PF</th>' +
      '<th scope="col" class="number">All-Play</th>' +
      '<th scope="col" class="number">AP %</th>' +
      '<th scope="col" class="number">Luck (W-AP)</th>' +
      '<th scope="col">Schedule</th>' +
      '</tr></thead>' +
      '<tbody>' +
      body +
      '</tbody></table></div>'
    )
  }

  function renderLuckTable(rows) {
    if (!rows || !rows.length) return '<p class="section-note">No regular-season games for this season.</p>'
    var body = rows
      .map(function (r) {
        var closeRecord = r.closeW + '-' + r.closeL + (r.closeT ? '-' + r.closeT : '')
        var closePct = r.closePct != null ? (r.closePct * 100).toFixed(0) + '%' : '—'
        var diffCell = r.luckDiff != null ? (r.luckDiff > 0 ? '+' + r.luckDiff : r.luckDiff) : '—'
        return (
          '<tr>' +
          '<td class="owner">' +
          ownerLink(r.owner) +
          '</td>' +
          '<td>' +
          escapeHtml(r.team) +
          '</td>' +
          '<td class="number">' +
          fmt(r.pf) +
          '</td>' +
          '<td class="number">' +
          r.pfRank +
          '</td>' +
          '<td class="number">' +
          closeRecord +
          '</td>' +
          '<td class="number">' +
          closePct +
          '</td>' +
          '<td class="number">' +
          diffCell +
          '</td>' +
          '<td class="detail">' +
          escapeHtml(r.luckLabel) +
          '</td>' +
          '</tr>'
        )
      })
      .join('\n')
    return (
      '<div class="table-container"><table class="stats-table">' +
      '<thead><tr>' +
      '<th scope="col">Owner</th>' +
      '<th scope="col">Team</th>' +
      '<th scope="col" class="number">PF</th>' +
      '<th scope="col" class="number">PF Rank</th>' +
      '<th scope="col" class="number">Close &lt;10</th>' +
      '<th scope="col" class="number">Close %</th>' +
      '<th scope="col" class="number">Luck (PF−Close)</th>' +
      '<th scope="col">Verdict</th>' +
      '</tr></thead>' +
      '<tbody>' +
      body +
      '</tbody></table></div>'
    )
  }

  function bindSelector(id, wrap, renderer, key) {
    var sel = document.getElementById(id)
    if (!sel || !wrap) return
    sel.addEventListener('change', function () {
      var season = sel.value
      var entry = perSeason[season]
      if (!entry) return
      var rows = entry[key]
      wrap.innerHTML = renderer(rows)
    })
  }

  bindSelector('allplay-season-select', allPlayWrap, renderAllPlayTable, 'allPlay')
  bindSelector('luck-season-select', luckWrap, renderLuckTable, 'luck')

  // Keep selectors in sync if there are two: sync to same season
  var allSel = document.getElementById('allplay-season-select')
  var luckSel = document.getElementById('luck-season-select')
  if (allSel && luckSel) {
    allSel.addEventListener('change', function () {
      if (luckSel.value !== allSel.value) {
        luckSel.value = allSel.value
        luckSel.dispatchEvent(new Event('change'))
      }
    })
    luckSel.addEventListener('change', function () {
      if (allSel.value !== luckSel.value) {
        allSel.value = luckSel.value
        allSel.dispatchEvent(new Event('change'))
      }
    })
  }
})()
