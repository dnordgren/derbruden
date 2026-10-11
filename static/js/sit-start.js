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
    owners.forEach(function (o) {
      effByOwnerSeason[o] = {}
    })
    seasons.forEach(function (s) {
      ;(perSeason[s].rows || []).forEach(function (r) {
        if (effByOwnerSeason[r.owner]) effByOwnerSeason[r.owner][s] = r.efficiency * 100
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
    if (legend) {
      owners.forEach(function (o) {
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'legend-chip'
        btn.setAttribute('aria-pressed', 'true')
        btn.innerHTML = '<span class="swatch" style="background:' + color(o) + '"></span>' + escapeHtml(o)
        btn.addEventListener('click', function () {
          hidden[o] = !hidden[o]
          btn.setAttribute('aria-pressed', hidden[o] ? 'false' : 'true')
          btn.classList.toggle('off', !!hidden[o])
          paths[o].style('display', hidden[o] ? 'none' : null)
          dots[o].style('display', hidden[o] ? 'none' : null)
        })
        legend.appendChild(btn)
      })
    }
  })
})()
