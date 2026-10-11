;(function () {
  'use strict'
  var dataEl = document.getElementById('sitstart-data')
  if (!dataEl) return
  var data
  try {
    data = JSON.parse(dataEl.textContent)
  } catch (e) {
    return
  }
  var perSeason = data.perSeason || {}
  var wrap = document.getElementById('sitstart-table-wrap')
  var sel = document.getElementById('sitstart-season-select')
  if (!perSeason || !Object.keys(perSeason).length || !wrap) return

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

  function renderSeasonTable(rows, season) {
    if (!rows || !rows.length) return '<p class="section-note">No decided regular-season games for this season.</p>'
    var body = rows
      .map(function (r) {
        return (
          '<tr>' +
          '<td class="number">' +
          r.rank +
          '</td>' +
          '<td class="owner">' +
          ownerLink(r.owner) +
          '</td>' +
          '<td>' +
          escapeHtml(r.team) +
          '</td>' +
          '<td class="number">' +
          r.weeks +
          '</td>' +
          '<td class="number">' +
          fmt(r.actual) +
          '</td>' +
          '<td class="number">' +
          fmt(r.optimal) +
          '</td>' +
          '<td class="number">' +
          (r.efficiency * 100).toFixed(1) +
          '%</td>' +
          '<td class="number">' +
          r.perfectWeeks +
          '</td>' +
          '</tr>'
        )
      })
      .join('\n')
    return (
      '<div class="table-container"><table class="stats-table">' +
      '<caption class="visually-hidden">' +
      escapeHtml(String(season)) +
      ' sit-start efficiency</caption>' +
      '<thead><tr>' +
      '<th scope="col" class="number">Rank</th>' +
      '<th scope="col">Owner</th>' +
      '<th scope="col">Team</th>' +
      '<th scope="col" class="number">Weeks</th>' +
      '<th scope="col" class="number">Actual</th>' +
      '<th scope="col" class="number">Optimal</th>' +
      '<th scope="col" class="number">Eff%</th>' +
      '<th scope="col" class="number">Perfect</th>' +
      '</tr></thead>' +
      '<tbody>' +
      body +
      '</tbody></table></div>'
    )
  }

  if (sel) {
    sel.addEventListener('change', function () {
      var entry = perSeason[sel.value]
      if (!entry) return
      wrap.innerHTML = renderSeasonTable(entry.rows, sel.value)
    })
  }
})()
