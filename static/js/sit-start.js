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
  function winCell(r) {
    if (r.winPct == null) return '\u2014'
    return r.winPct.toFixed(3).replace('0.', '.')
  }
  function winTitle(r) {
    if (r.winPct == null) return 'No final record yet'
    return r.wins + '-' + r.losses
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
          '<td class="number" title="' +
          winTitle(r) +
          '">' +
          winCell(r) +
          '</td>' +
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
      '<th scope="col" class="number">Win%</th>' +
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

  // Manager wins added: career table is static HTML; the season table
  // swaps with its own selector. Guards keep older JSON (no
  // managerWinsAdded key) working with this script.
  var mwa = data.managerWinsAdded || { perSeason: {} }
  var mPerSeason = mwa.perSeason || {}
  var mWrap = document.getElementById('mwa-table-wrap')
  var mSel = document.getElementById('mwa-season-select')
  function fmtSigned(n) {
    if (n > 0) return '+' + n
    return String(n)
  }
  function renderMwaTable(rows, season) {
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
          r.games +
          '</td>' +
          '<td class="number">' +
          r.stolen +
          '</td>' +
          '<td class="number">' +
          r.avoidable +
          '</td>' +
          '<td class="number" title="' +
          r.stolen +
          ' stolen wins, ' +
          r.avoidable +
          ' avoidable losses">' +
          fmtSigned(r.mwa) +
          '</td>' +
          '</tr>'
        )
      })
      .join('\n')
    return (
      '<div class="table-container"><table class="stats-table">' +
      '<caption class="visually-hidden">' +
      escapeHtml(String(season)) +
      ' manager wins added</caption>' +
      '<thead><tr>' +
      '<th scope="col" class="number">Rank</th>' +
      '<th scope="col">Owner</th>' +
      '<th scope="col">Team</th>' +
      '<th scope="col" class="number">Games</th>' +
      '<th scope="col" class="number">Stolen</th>' +
      '<th scope="col" class="number">Avoidable</th>' +
      '<th scope="col" class="number">MWA</th>' +
      '</tr></thead>' +
      '<tbody>' +
      body +
      '</tbody></table></div>'
    )
  }
  if (mSel && mWrap) {
    mSel.addEventListener('change', function () {
      var entry = mPerSeason[mSel.value]
      if (!entry) return
      mWrap.innerHTML = renderMwaTable(entry.rows, mSel.value)
    })
  }

  // Season-over-season efficiency trend, one line per owner. Deferred
  // until DOMContentLoaded so the deferred d3 bundle is ready.
  window.addEventListener('DOMContentLoaded', function () {
    var mount = document.getElementById('sitstart-chart')
    var legend = document.getElementById('sitstart-legend')
    if (!mount || typeof d3 === 'undefined') return
    var seasons = Object.keys(perSeason)
      .map(Number)
      .sort(function (a, b) {
        return a - b
      })
    if (seasons.length < 2) return
    var owners = (data.career || []).map(function (r) {
      return r.owner
    })
    if (!owners.length) return
    var effByOwnerSeason = {}
    var winByOwnerSeason = {}
    var wlByOwnerSeason = {}
    owners.forEach(function (o) {
      effByOwnerSeason[o] = {}
      winByOwnerSeason[o] = {}
      wlByOwnerSeason[o] = {}
    })
    seasons.forEach(function (s) {
      ;(perSeason[s].rows || []).forEach(function (r) {
        if (effByOwnerSeason[r.owner]) effByOwnerSeason[r.owner][s] = r.efficiency * 100
        if (r.winPct != null && winByOwnerSeason[r.owner]) {
          winByOwnerSeason[r.owner][s] = r.winPct * 100
          wlByOwnerSeason[r.owner][s] = r.wins + '-' + r.losses
        }
      })
    })
    var allVals = []
    owners.forEach(function (o) {
      seasons.forEach(function (s) {
        if (effByOwnerSeason[o][s] != null) allVals.push(effByOwnerSeason[o][s])
      })
    })
    if (!allVals.length) return
    // Truncated axis: snap the floor to 5 so the tight 75-94 band is
    // legible. The section note states the axis start plainly.
    var floor = Math.floor(d3.min(allVals) / 5) * 5
    var W = 800
    var H = 320
    var m = { top: 16, right: 56, bottom: 30, left: 44 }
    var innerW = W - m.left - m.right
    var innerH = H - m.top - m.bottom
    var palette = d3.schemeTableau10
    var color = function (o) {
      return palette[owners.indexOf(o) % palette.length]
    }
    function shortSeason(y) {
      return "'" + String(y).slice(2)
    }
    var chart = d3
      .select('#sitstart-chart')
      .append('svg')
      .attr('viewBox', '0 0 ' + W + ' ' + H)
      .attr('width', '100%')
      .attr('role', 'img')
      .attr(
        'aria-label',
        'Season-by-season sit-start efficiency by owner, percent. Y-axis starts at ' + floor + ' percent.'
      )
      .append('g')
      .attr('transform', 'translate(' + m.left + ',' + m.top + ')')
    var x = d3.scalePoint().domain(seasons).range([0, innerW]).padding(0.5)
    var y = d3.scaleLinear().domain([floor, 100]).range([innerH, 0])
    var yWin = d3.scaleLinear().domain([0, 100]).range([innerH, 0])
    chart
      .append('g')
      .attr('transform', 'translate(0,' + innerH + ')')
      .call(d3.axisBottom(x).tickFormat(shortSeason))
    chart.append('g').call(
      d3
        .axisLeft(y)
        .ticks(6)
        .tickFormat(function (d) {
          return d + '%'
        })
    )
    chart
      .selectAll('.grid-line')
      .data(y.ticks(6))
      .enter()
      .append('line')
      .attr('class', 'grid-line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', y)
      .attr('y2', y)
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.12)
    var tip = d3.select('body').append('div').attr('class', 'viz-tooltip')
    function hideTip() {
      tip.style('display', 'none')
    }
    document.addEventListener('scroll', hideTip, { capture: true, passive: true })
    // Win% overlay (dashed, right axis): only when exactly one owner is
    // visible, so the second axis never muddies a multi-owner view.
    function visibleOwners() {
      return owners.filter(function (o) {
        return !hidden[o]
      })
    }
    function refreshWinLine() {
      chart.selectAll('.win-group').remove()
      var vis = visibleOwners()
      if (vis.length !== 1) return
      var o = vis[0]
      var pts = seasons.filter(function (s) {
        return winByOwnerSeason[o][s] != null
      })
      if (!pts.length) return
      var g = chart.append('g').attr('class', 'win-group')
      g.append('g')
        .attr('transform', 'translate(' + innerW + ',0)')
        .call(
          d3
            .axisRight(yWin)
            .ticks(5)
            .tickFormat(function (d) {
              return d + '%'
            })
        )
      g.append('text')
        .attr('x', innerW + 8)
        .attr('y', -6)
        .attr('fill', 'currentColor')
        .attr('opacity', 0.65)
        .style('font-size', '10px')
        .text('win%')
      g.append('path')
        .datum(seasons)
        .attr('fill', 'none')
        .attr('stroke', color(o))
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '5 4')
        .attr(
          'd',
          d3
            .line()
            .defined(function (s) {
              return winByOwnerSeason[o][s] != null
            })
            .x(function (s) {
              return x(s)
            })
            .y(function (s) {
              return yWin(winByOwnerSeason[o][s])
            })
        )
      g.selectAll('.win-dot')
        .data(pts)
        .enter()
        .append('rect')
        .attr('x', function (s) {
          return x(s) - 3.5
        })
        .attr('y', function (s) {
          return yWin(winByOwnerSeason[o][s]) - 3.5
        })
        .attr('width', 7)
        .attr('height', 7)
        .attr('fill', color(o))
        .on('mouseenter', function (event, s) {
          tip
            .style('display', 'block')
            .html(
              '<strong>' +
                escapeHtml(o) +
                ' \u2019' +
                shortSeason(s) +
                ' win</strong><br>' +
                winByOwnerSeason[o][s].toFixed(1) +
                '% (' +
                escapeHtml(wlByOwnerSeason[o][s]) +
                ')'
            )
            .style('left', Math.max(8, Math.min(event.clientX + 14, window.innerWidth - 180)) + 'px')
            .style('top', Math.max(8, event.clientY - 12) + 'px')
        })
        .on('mouseleave', hideTip)
    }
    var hidden = {}
    var paths = {}
    var dots = {}
    function lineFor(o) {
      return d3
        .line()
        .defined(function (s) {
          return effByOwnerSeason[o][s] != null
        })
        .x(function (s) {
          return x(s)
        })
        .y(function (s) {
          return y(effByOwnerSeason[o][s])
        })
    }
    owners.forEach(function (o) {
      paths[o] = chart
        .append('path')
        .datum(seasons)
        .attr('fill', 'none')
        .attr('stroke', color(o))
        .attr('stroke-width', 2)
        .attr('d', lineFor(o))
      dots[o] = chart
        .selectAll('.dot-' + o)
        .data(
          seasons.filter(function (s) {
            return effByOwnerSeason[o][s] != null
          })
        )
        .enter()
        .append('circle')
        .attr('cx', function (s) {
          return x(s)
        })
        .attr('cy', function (s) {
          return y(effByOwnerSeason[o][s])
        })
        .attr('r', 3.5)
        .attr('fill', color(o))
        .on('mouseenter', function (event, s) {
          tip
            .style('display', 'block')
            .html(
              '<strong>' +
                escapeHtml(o) +
                ' \u2019' +
                shortSeason(s) +
                '</strong><br>' +
                effByOwnerSeason[o][s].toFixed(1) +
                '%'
            )
            .style('left', Math.max(8, Math.min(event.clientX + 14, window.innerWidth - 180)) + 'px')
            .style('top', Math.max(8, event.clientY - 12) + 'px')
        })
        .on('mouseleave', hideTip)
    })
    // End-of-line owner labels at each line's latest season, nudged
    // apart so bunched lines stay readable on small screens.
    var labels = {}
    ;(function renderLabels() {
      var items = []
      owners.forEach(function (o) {
        var last = null
        seasons.forEach(function (s) {
          if (effByOwnerSeason[o][s] != null) last = s
        })
        if (last == null) return
        items.push({ o: o, s: last, val: y(effByOwnerSeason[o][last]) })
      })
      items.sort(function (a, b) {
        return a.val - b.val
      })
      for (var i = 1; i < items.length; i++) {
        if (items[i].val - items[i - 1].val < 11) items[i].val = items[i - 1].val + 11
      }
      var surface = (getComputedStyle(document.documentElement).getPropertyValue('--surface') || '').trim() || '#fff'
      items.forEach(function (it) {
        labels[it.o] = chart
          .append('text')
          .attr('x', x(it.s) + 6)
          .attr('y', it.val + 3.5)
          .attr('fill', color(it.o))
          .attr('stroke', surface)
          .attr('stroke-width', 3)
          .style('paint-order', 'stroke')
          .style('font-size', '10px')
          .style('font-weight', '700')
          .text(it.o)
      })
    })()
    if (legend) {
      var chips = {}
      function setOwner(o, hide) {
        hidden[o] = hide
        chips[o].setAttribute('aria-pressed', hide ? 'false' : 'true')
        chips[o].classList.toggle('off', hide)
        paths[o].style('display', hide ? 'none' : null)
        dots[o].style('display', hide ? 'none' : null)
        if (labels[o]) labels[o].style('display', hide ? 'none' : null)
      }
      var allBtn = document.createElement('button')
      allBtn.type = 'button'
      allBtn.className = 'legend-chip legend-all'
      allBtn.textContent = 'All off'
      allBtn.addEventListener('click', function () {
        var showAll = allBtn.textContent === 'All on'
        owners.forEach(function (o) {
          setOwner(o, !showAll)
        })
        refreshWinLine()
        allBtn.textContent = showAll ? 'All off' : 'All on'
      })
      legend.appendChild(allBtn)
      owners.forEach(function (o) {
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'legend-chip'
        btn.setAttribute('aria-pressed', 'true')
        btn.innerHTML = '<span class="swatch" style="background:' + color(o) + '"></span>' + escapeHtml(o)
        btn.addEventListener('click', function () {
          setOwner(o, !hidden[o])
          refreshWinLine()
          var allVisible = owners.every(function (x) {
            return !hidden[x]
          })
          allBtn.textContent = allVisible ? 'All off' : 'All on'
        })
        chips[o] = btn
        legend.appendChild(btn)
      })
      // Start with a single random owner isolated so the win% overlay
      // shows immediately; All on is one press away.
      var first = owners[Math.floor(Math.random() * owners.length)]
      owners.forEach(function (o) {
        if (o !== first) setOwner(o, true)
      })
      refreshWinLine()
      allBtn.textContent = 'All on'
    }
  })
})()
