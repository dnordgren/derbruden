;(function () {
  'use strict'

  var dataEl = document.getElementById('records-h2h-data')
  if (!dataEl || typeof d3 === 'undefined') return

  var data = JSON.parse(dataEl.textContent)
  var owners = data.owners
  var records = data.records
  if (!owners || !owners.length || !records) return

  var COLORS = {
    win: '#008f00',
    loss: '#d60303',
    neutral: '#5a6572',
    grid: '#e6eaef',
    diag: '#ededeb',
  }

  var tooltip = d3.select('body').append('div').attr('class', 'viz-tooltip')

  function showTip(event, html) {
    tooltip
      .style('display', 'block')
      .html(html)
      .style('left', Math.min(event.clientX + 14, window.innerWidth - 200) + 'px')
      .style('top', event.clientY - 12 + 'px')
  }

  function hideTip() {
    tooltip.style('display', 'none')
  }

  var cell = 44
  var m = { top: 44, right: 12, bottom: 14, left: 44 }
  var W = m.left + owners.length * cell + m.right
  var H = m.top + owners.length * cell + m.bottom

  var mount = d3.select('#records-h2h-chart')
  mount.selectAll('*').remove()
  var svgSel = mount
    .append('svg')
    .attr('viewBox', '0 0 ' + W + ' ' + H)
    .attr('width', '100%')
    .attr('role', 'img')

  var chart = svgSel.append('g').attr('transform', 'translate(' + m.left + ',' + m.top + ')')

  var rate = function (c) {
    var games = c.wins + c.losses + c.ties
    return games ? (c.wins + c.ties * 0.5) / games : 0.5
  }

  var color = d3.scaleLinear().domain([0, 0.5, 1]).range([COLORS.loss, '#f4f4f1', COLORS.win]).clamp(true)

  chart
    .selectAll('.col-label')
    .data(owners)
    .enter()
    .append('text')
    .attr('x', function (d, i) {
      return i * cell + cell / 2
    })
    .attr('y', -12)
    .attr('text-anchor', 'middle')
    .attr('fill', COLORS.neutral)
    .style('font-size', '11px')
    .style('font-weight', 600)
    .text(function (d) {
      return d
    })

  chart
    .selectAll('.row-label')
    .data(owners)
    .enter()
    .append('text')
    .attr('x', -10)
    .attr('y', function (d, i) {
      return i * cell + cell / 2 + 4
    })
    .attr('text-anchor', 'end')
    .attr('fill', COLORS.neutral)
    .style('font-size', '11px')
    .style('font-weight', 600)
    .text(function (d) {
      return d
    })

  owners.forEach(function (r, i) {
    owners.forEach(function (c, j) {
      if (r === c) {
        chart
          .append('rect')
          .attr('x', j * cell)
          .attr('y', i * cell)
          .attr('width', cell)
          .attr('height', cell)
          .attr('rx', 4)
          .attr('fill', COLORS.diag)
        chart
          .append('text')
          .attr('x', j * cell + cell / 2)
          .attr('y', i * cell + cell / 2 + 4)
          .attr('text-anchor', 'middle')
          .attr('fill', '#a5adb6')
          .style('font-size', '10px')
          .text(r)
        return
      }
      var rec = (records[r] && records[r][c]) || null
      if (!rec || rec.wins + rec.losses + rec.ties === 0) {
        chart
          .append('rect')
          .attr('x', j * cell)
          .attr('y', i * cell)
          .attr('width', cell)
          .attr('height', cell)
          .attr('rx', 4)
          .attr('fill', '#fafafa')
        return
      }
      var rRate = rate(rec)
      var strong = Math.abs(rRate - 0.5) > 0.32
      var games = rec.wins + rec.losses + rec.ties
      function handle(event) {
        showTip(
          event,
          '<strong>' +
            r +
            ' vs ' +
            c +
            '</strong><br>' +
            rec.wins +
            '-' +
            rec.losses +
            (rec.ties ? '-' + rec.ties : '') +
            ' (' +
            d3.format('.3f')(rRate).replace('0.', '.') +
            ')<br>' +
            'Games: ' +
            games
        )
      }
      chart
        .append('rect')
        .attr('x', j * cell)
        .attr('y', i * cell)
        .attr('width', cell - 2)
        .attr('height', cell - 2)
        .attr('rx', 4)
        .attr('fill', color(rRate))
        .on('mouseover', handle)
        .on('mousemove', handle)
        .on('mouseout', hideTip)
      chart
        .append('text')
        .attr('x', j * cell + (cell - 2) / 2)
        .attr('y', i * cell + (cell - 2) / 2 + 4)
        .attr('text-anchor', 'middle')
        .attr('fill', strong ? '#fff' : '#2e3440')
        .style('font-size', '10px')
        .style('font-weight', 600)
        .style('pointer-events', 'none')
        .text(rec.wins + '-' + rec.losses + (rec.ties ? '-' + rec.ties : ''))
    })
  })
})()
