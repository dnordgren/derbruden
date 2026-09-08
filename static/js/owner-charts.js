;(function () {
  'use strict'

  var dataEl = document.getElementById('owner-viz-data')
  if (!dataEl || typeof d3 === 'undefined') return

  var data = JSON.parse(dataEl.textContent)

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  }

  var COLORS = {
    pf: cssVar('--chart-pf', '#1a7f37'),
    pa: cssVar('--chart-pa', '#c0392b'),
    elo: cssVar('--chart-elo', '#1a3a5a'),
    neutral: cssVar('--chart-neutral', '#5a6572'),
    grid: cssVar('--chart-grid', '#e6eaef'),
    connector: cssVar('--chart-connector', '#dbe2ea'),
    diag: cssVar('--chart-diag', '#f0f0ef'),
  }

  var tooltip = d3.select('body').append('div').attr('class', 'viz-tooltip')

  function showTip(event, html) {
    tooltip
      .style('display', 'block')
      .html(html)
      .style('left', Math.min(event.clientX + 14, window.innerWidth - 180) + 'px')
      .style('top', event.clientY - 12 + 'px')
  }

  function hideTip() {
    tooltip.style('display', 'none')
  }

  function shortSeason(year) {
    return "'" + String(year).slice(2)
  }

  function fmt(n) {
    return Number(n).toLocaleString('en-US')
  }

  function signedFmt(n) {
    n = Math.round(n)
    return n > 0 ? '+' + fmt(n) : fmt(n)
  }

  function svg(mountId, width, height) {
    var mount = d3.select(mountId)
    mount.selectAll('*').remove()
    return mount
      .append('svg')
      .attr('viewBox', '0 0 ' + width + ' ' + height)
      .attr('width', '100%')
      .attr('role', 'img')
  }

  function renderDumbbell() {
    var rows = (data.pfpa || []).slice().sort(function (a, b) {
      return a.season - b.season
    })
    if (!rows.length) return

    var W = 800
    var m = { top: 34, right: 80, bottom: 50, left: 54 }
    var H = 400

    var chart = svg('#viz-pfpa', W, H)
      .append('g')
      .attr('transform', 'translate(' + m.left + ',' + m.top + ')')

    var innerW = W - m.left - m.right
    var innerH = H - m.top - m.bottom

    var lo =
      Math.floor(
        d3.min(rows, function (d) {
          return Math.min(d.pf, d.pa)
        }) / 200
      ) * 200
    var hi =
      Math.ceil(
        d3.max(rows, function (d) {
          return Math.max(d.pf, d.pa)
        }) / 200
      ) * 200

    var x = d3
      .scalePoint()
      .domain(
        rows.map(function (d) {
          return d.season
        })
      )
      .range([0, innerW])
      .padding(0.3)

    var y = d3.scaleLinear().domain([lo, hi]).range([innerH, 0])

    chart
      .append('g')
      .selectAll('line')
      .data(y.ticks(innerH / 50))
      .enter()
      .append('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', y)
      .attr('y2', y)
      .attr('stroke', COLORS.grid)

    chart
      .append('g')
      .attr('transform', 'translate(0,' + innerH + ')')
      .call(
        d3
          .axisBottom(x)
          .tickFormat(function (d) {
            return shortSeason(d)
          })
          .tickSize(0)
          .tickPadding(10)
      )
      .call(function (g) {
        g.select('.domain').remove()
      })
      .selectAll('text')
      .attr('fill', COLORS.neutral)
      .style('font-size', '11px')

    chart
      .append('g')
      .call(
        d3
          .axisLeft(y)
          .tickValues(y.ticks(innerH / 50))
          .tickFormat(d3.format('~s'))
          .tickSize(0)
          .tickPadding(8)
      )
      .call(function (g) {
        g.select('.domain').remove()
      })
      .selectAll('text')
      .attr('fill', COLORS.neutral)
      .style('font-size', '11px')

    var rowG = chart.append('g').selectAll('g').data(rows).enter().append('g')

    rowG
      .append('line')
      .attr('x1', function (d) {
        return x(d.season)
      })
      .attr('x2', function (d) {
        return x(d.season)
      })
      .attr('y1', function (d) {
        return y(Math.min(d.pf, d.pa))
      })
      .attr('y2', function (d) {
        return y(Math.max(d.pf, d.pa))
      })
      .attr('stroke', COLORS.connector)
      .attr('stroke-width', 6)
      .attr('stroke-linecap', 'round')

    function dot(key) {
      function handle(event, d) {
        showTip(
          event,
          '<strong>' +
            d.season +
            '</strong><br>' +
            'PF: ' +
            fmt(d.pf) +
            '<br>PA: ' +
            fmt(d.pa) +
            '<br>' +
            'Diff: <strong>' +
            signedFmt(d.pf - d.pa) +
            '</strong>'
        )
      }
      rowG
        .append('circle')
        .attr('cx', function (d) {
          return x(d.season)
        })
        .attr('cy', function (d) {
          return y(d[key])
        })
        .attr('r', 5.5)
        .attr('fill', key === 'pf' ? COLORS.pf : COLORS.pa)
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .on('mouseover', handle)
        .on('mousemove', handle)
        .on('mouseout', hideTip)
    }

    dot('pa')
    dot('pf')

    rowG
      .append('text')
      .attr('x', function (d) {
        return x(d.season) + 10
      })
      .attr('y', function (d) {
        return y(Math.max(d.pf, d.pa)) + 4
      })
      .attr('fill', function (d) {
        return d.pf >= d.pa ? COLORS.pf : COLORS.pa
      })
      .style('font-size', '11px')
      .style('font-weight', 600)
      .style('font-variant-numeric', 'tabular-nums')
      .text(function (d) {
        return signedFmt(d.pf - d.pa)
      })

    var legend = chart.append('g').attr('transform', 'translate(0,-18)')
    ;[
      ['PF', COLORS.pf],
      ['PA', COLORS.pa],
    ].forEach(function (item, i) {
      legend
        .append('circle')
        .attr('cx', i * 52)
        .attr('cy', -4)
        .attr('r', 5)
        .attr('fill', item[1])
      legend
        .append('text')
        .attr('x', i * 52 + 10)
        .attr('y', 0)
        .attr('fill', COLORS.neutral)
        .style('font-size', '11px')
        .text(item[0])
    })
  }

  function renderElo() {
    var points = data.elo && data.elo.points
    var starts = (data.elo && data.elo.seasonStarts) || []
    if (!points || points.length < 2) return

    var W = 800
    var H = 250
    var m = { top: 16, right: 60, bottom: 30, left: 50 }
    var chart = svg('#viz-elo', W, H)
      .append('g')
      .attr('transform', 'translate(' + m.left + ',' + m.top + ')')

    var innerW = W - m.left - m.right
    var innerH = H - m.top - m.bottom

    var lo =
      d3.min(
        [1500].concat(
          points.map(function (p) {
            return p[1]
          })
        )
      ) - 15
    var hi =
      d3.max(
        [1500].concat(
          points.map(function (p) {
            return p[1]
          })
        )
      ) + 15
    var x = d3
      .scaleLinear()
      .domain([0, points[points.length - 1][0]])
      .range([0, innerW])
    var y = d3.scaleLinear().domain([lo, hi]).range([innerH, 0])

    chart
      .append('g')
      .selectAll('line')
      .data(starts)
      .enter()
      .append('line')
      .attr('x1', function (d) {
        return x(d[0])
      })
      .attr('x2', function (d) {
        return x(d[0])
      })
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', COLORS.grid)

    chart
      .append('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', y(1500))
      .attr('y2', y(1500))
      .attr('stroke', COLORS.neutral)
      .attr('stroke-dasharray', '4 4')
      .attr('opacity', 0.6)
    chart
      .append('text')
      .attr('x', innerW + 6)
      .attr('y', y(1500) + 4)
      .attr('fill', COLORS.neutral)
      .style('font-size', '10px')
      .text('1500')

    chart
      .append('path')
      .datum(points)
      .attr('fill', 'none')
      .attr('stroke', COLORS.elo)
      .attr('stroke-width', 2)
      .attr('stroke-linejoin', 'round')
      .attr(
        'd',
        d3
          .line()
          .x(function (d) {
            return x(d[0])
          })
          .y(function (d) {
            return y(d[1])
          })
      )

    var last = points[points.length - 1]
    chart.append('circle').attr('cx', x(last[0])).attr('cy', y(last[1])).attr('r', 4).attr('fill', COLORS.elo)
    chart
      .append('text')
      .attr('x', x(last[0]) + 8)
      .attr('y', y(last[1]) + 4)
      .attr('fill', COLORS.elo)
      .style('font-size', '11px')
      .style('font-weight', 700)
      .text(String(Math.round(last[1])))

    chart
      .append('g')
      .attr('transform', 'translate(0,' + innerH + ')')
      .call(
        d3
          .axisBottom(x)
          .tickValues(
            starts.map(function (d) {
              return d[0]
            })
          )
          .tickFormat(function (idxValue) {
            var found = starts.find(function (s) {
              return s[0] === idxValue
            })
            return found ? shortSeason(found[1]) : ''
          })
          .tickSize(0)
          .tickPadding(8)
      )
      .call(function (g) {
        g.select('.domain').remove()
      })
      .selectAll('text')
      .attr('fill', COLORS.neutral)
      .style('font-size', '11px')

    chart
      .append('g')
      .call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(8).tickFormat(d3.format('~')))
      .call(function (g) {
        g.select('.domain').remove()
      })
      .selectAll('text')
      .attr('fill', COLORS.neutral)
      .style('font-size', '11px')

    var guide = chart
      .append('line')
      .attr('stroke', COLORS.neutral)
      .attr('stroke-dasharray', '3 3')
      .style('display', 'none')
    var marker = chart
      .append('circle')
      .attr('r', 4.5)
      .attr('fill', COLORS.elo)
      .attr('stroke', '#fff')
      .style('display', 'none')

    function locate(idxValue) {
      return points.reduce(function (best, p) {
        return Math.abs(p[0] - idxValue) < Math.abs(best[0] - idxValue) ? p : best
      })
    }

    chart
      .append('rect')
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .on('mousemove', function (event) {
        var coords = d3.pointer(event)
        var p = locate(x.invert(coords[0]))
        var season = 0
        for (var i = starts.length - 1; i >= 0; i--) {
          if (starts[i][0] <= p[0]) {
            season = starts[i][1]
            break
          }
        }
        var weekIdx =
          p[0] -
          starts
            .filter(function (s) {
              return s[0] <= p[0]
            })
            .pop()[0]
        var weekLabel = weekIdx === 0 ? 'preseason' : 'week ' + weekIdx
        guide.attr('x1', x(p[0])).attr('x2', x(p[0])).attr('y1', 0).attr('y2', innerH).style('display', null)
        marker.attr('cx', x(p[0])).attr('cy', y(p[1])).style('display', null)
        showTip(
          event,
          '<strong>' + season + '</strong> · ' + weekLabel + '<br>Elo: <strong>' + Math.round(p[1]) + '</strong>'
        )
      })
      .on('mouseleave', function () {
        guide.style('display', 'none')
        marker.style('display', 'none')
        hideTip()
      })
  }

  function renderH2H() {
    var owners = data.h2h && data.h2h.owners
    var row = data.h2h && data.h2h.row
    var me = data.owner
    if (!owners || !owners.length || !row || !me) return

    var opponents = owners.filter(function (o) {
      return o !== me
    })
    if (!opponents.length) return

    var cell = 56
    var m = { top: 12, right: 24, bottom: 58, left: 48 }
    var W = m.left + opponents.length * cell + m.right
    var H = 140

    var svgSel = svg('#viz-h2h', W, H)
    var chart = svgSel.append('g').attr('transform', 'translate(' + m.left + ',' + m.top + ')')

    var rate = function (c) {
      var games = c.w + c.l + c.t
      return games ? (c.w + c.t * 0.5) / games : 0.5
    }
    var color = d3.scaleLinear().domain([0, 0.5, 1]).range([COLORS.pa, COLORS.diag, COLORS.pf]).clamp(true)

    var x = d3
      .scaleBand()
      .domain(opponents)
      .range([0, opponents.length * cell])
      .padding(0.12)

    chart
      .selectAll('.opp-label')
      .data(opponents)
      .enter()
      .append('text')
      .attr('x', function (d) {
        return x(d) + x.bandwidth() / 2
      })
      .attr('y', x.bandwidth() + 18)
      .attr('text-anchor', 'middle')
      .attr('fill', COLORS.neutral)
      .style('font-size', '12px')
      .style('font-weight', 600)
      .text(function (d) {
        return d
      })

    opponents.forEach(function (opp) {
      var rec = row[opp]
      var g = chart.append('g')
      if (!rec || rec.w + rec.l + rec.t === 0) {
        g.append('rect')
          .attr('x', x(opp))
          .attr('y', 0)
          .attr('width', x.bandwidth())
          .attr('height', x.bandwidth())
          .attr('rx', 4)
          .attr('fill', cssVar('--surface', '#fafafa'))
          .attr('stroke', cssVar('--line', '#e5e7eb'))
          .attr('stroke-width', 0.5)
        return
      }
      var rRate = rate(rec)
      var strong = Math.abs(rRate - 0.5) > 0.32
      function handle(event) {
        showTip(
          event,
          '<strong>vs ' +
            opp +
            '</strong><br>' +
            rec.w +
            '-' +
            rec.l +
            (rec.t ? '-' + rec.t : '') +
            ' (' +
            d3.format('.3f')(rRate).replace('0.', '.') +
            ')<br>' +
            'PF: ' +
            fmt(rec.pf) +
            ' · PA: ' +
            fmt(rec.pa)
        )
      }
      g.append('rect')
        .attr('x', x(opp))
        .attr('y', 0)
        .attr('width', x.bandwidth())
        .attr('height', x.bandwidth())
        .attr('rx', 4)
        .attr('fill', color(rRate))
        .on('mouseover', handle)
        .on('mousemove', handle)
        .on('mouseout', hideTip)
      g.append('text')
        .attr('x', x(opp) + x.bandwidth() / 2)
        .attr('y', x.bandwidth() / 2 + 4)
        .attr('text-anchor', 'middle')
        .attr('fill', strong ? '#fff' : cssVar('--ink', '#2e3440'))
        .style('font-size', '12px')
        .style('font-weight', 700)
        .style('pointer-events', 'none')
        .text(rec.w + '-' + rec.l + (rec.t ? '-' + rec.t : ''))
    })

    var gradId = 'viz-h2h-gradient'
    var legendY = x.bandwidth() + 44
    var legendW = opponents.length * cell

    var grad = svgSel.append('defs').append('linearGradient').attr('id', gradId)
    ;[0, 0.5, 1].forEach(function (stop) {
      grad
        .append('stop')
        .attr('offset', stop * 100 + '%')
        .attr('stop-color', color(stop))
    })
    svgSel
      .append('rect')
      .attr('x', m.left)
      .attr('y', legendY)
      .attr('width', legendW)
      .attr('height', 10)
      .attr('rx', 3)
      .attr('fill', 'url(#' + gradId + ')')
    ;[
      [0, 'all L'],
      [0.5, '.500'],
      [1, 'all W'],
    ].forEach(function (tick) {
      svgSel
        .append('text')
        .attr('x', m.left + tick[0] * legendW)
        .attr('y', legendY + 22)
        .attr('text-anchor', tick[0] === 0 ? 'start' : tick[0] === 1 ? 'end' : 'middle')
        .attr('fill', COLORS.neutral)
        .style('font-size', '10px')
        .text(tick[1])
    })
  }

  renderDumbbell()
  renderElo()
  renderH2H()
})()
