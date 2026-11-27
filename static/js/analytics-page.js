;(function () {
  'use strict'

  var DATA_URL = '../static/data/analytics.json'

  var PAGE_LABELS = {
    '/': 'Home (Power Rankings)',
    '/about.html': 'About',
    '/owners.html': 'Owners',
    '/records.html': 'Records & Luck',
    '/sit-start.html': 'Sit/Start',
    '/transactions.html': 'Transactions',
    '/drafts.html': 'Drafts',
    '/playoff-race.html': 'Playoff & Diaper Races',
    '/analytics.html': 'Site Analytics',
    '/votes/relegation.html': 'Vote: Relegation',
    '/an.html': 'Owner: AN',
    '/ar.html': 'Owner: AR',
    '/cr.html': 'Owner: CR',
    '/dm.html': 'Owner: DM',
    '/dn.html': 'Owner: DN',
    '/gm.html': 'Owner: GM',
    '/ik.html': 'Owner: IK',
    '/jh.html': 'Owner: JH',
    '/jo.html': 'Owner: JO',
    '/zs.html': 'Owner: ZS',
  }

  var COUNTRY_NAMES = {
    AE: 'UAE',
    AR: 'Argentina',
    AT: 'Austria',
    AU: 'Australia',
    BE: 'Belgium',
    BG: 'Bulgaria',
    BH: 'Bahrain',
    BR: 'Brazil',
    CA: 'Canada',
    CH: 'Switzerland',
    CL: 'Chile',
    CO: 'Colombia',
    CZ: 'Czechia',
    DE: 'Germany',
    DK: 'Denmark',
    EG: 'Egypt',
    ES: 'Spain',
    FI: 'Finland',
    FR: 'France',
    GB: 'United Kingdom',
    GR: 'Greece',
    HK: 'Hong Kong',
    HR: 'Croatia',
    HU: 'Hungary',
    ID: 'Indonesia',
    IE: 'Ireland',
    IL: 'Israel',
    IN: 'India',
    IT: 'Italy',
    JP: 'Japan',
    KE: 'Kenya',
    KR: 'South Korea',
    MX: 'Mexico',
    MY: 'Malaysia',
    NG: 'Nigeria',
    NL: 'Netherlands',
    NO: 'Norway',
    NZ: 'New Zealand',
    OM: 'Oman',
    PE: 'Peru',
    PH: 'Philippines',
    PL: 'Poland',
    PT: 'Portugal',
    RO: 'Romania',
    SE: 'Sweden',
    SG: 'Singapore',
    TH: 'Thailand',
    TR: 'Turkey',
    TW: 'Taiwan',
    US: 'United States',
    VN: 'Vietnam',
    ZA: 'South Africa',
  }

  var state = {
    data: null,
    windowKey: '30d',
    showBotsDaily: true,
    locFilter: 'all',
  }

  var tooltip = null

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function fmtInt(n) {
    return Number(n || 0).toLocaleString('en-US')
  }

  function fmtPct(ratio) {
    return (Number(ratio || 0) * 100).toFixed(1) + '%'
  }

  function fmtBytes(bytes) {
    var b = Number(bytes || 0)
    if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB'
    if (b >= 1024) return Math.round(b / 1024) + ' KB'
    return b + ' B'
  }

  function fmtDateShort(isoDate) {
    if (!isoDate) return ''
    var parts = String(isoDate).split('-')
    if (parts.length !== 3) return isoDate
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    var m = Number(parts[1]) - 1
    var d = Number(parts[2])
    if (m < 0 || m > 11) return isoDate
    return months[m] + ' ' + d
  }

  function fmtDateFull(iso) {
    if (!iso) return ''
    var dt = new Date(iso)
    if (Number.isNaN(dt.getTime())) return String(iso)
    try {
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    } catch (e) {
      return String(iso).slice(0, 10)
    }
  }

  function countryName(code) {
    return COUNTRY_NAMES[code] || code || 'Unknown'
  }

  function safePageHref(uri) {
    if (!/^\/[a-zA-Z0-9._/-]*$/.test(uri)) return null
    return uri === '/' ? './index.html' : '.' + uri
  }

  function getTooltip() {
    if (tooltip) return tooltip
    if (typeof d3 === 'undefined') return null
    tooltip = d3.select('body').append('div').attr('class', 'viz-tooltip')
    document.addEventListener(
      'scroll',
      function () {
        tooltip.style('display', 'none')
      },
      { capture: true, passive: true }
    )
    return tooltip
  }

  function showTooltip(event, html) {
    var tip = getTooltip()
    if (!tip) return
    tip.html(html).style('display', 'block')
    var x = Math.min(event.clientX + 12, window.innerWidth - 220)
    var y = Math.max(8, event.clientY - 14)
    tip.style('left', x + 'px').style('top', y + 'px')
  }

  function hideTooltip() {
    if (tooltip) tooltip.style('display', 'none')
  }

  // Bucket daily tuples into ISO-Monday weekly sums when All Time exceeds 120
  // days so bars stay legible across multi-season history.
  function bucketDailyRows(rows) {
    if (rows.length <= 120) {
      return {
        bucketed: false,
        rows: rows.map(function (r) {
          return {
            label: r[0],
            pageViews: r[1],
            humanHits: r[2],
            botHits: r[3],
            visitors: r[4],
            bytes: r[5],
          }
        }),
      }
    }
    var byWeek = new Map()
    rows.forEach(function (r) {
      var dt = new Date(r[0] + 'T00:00:00Z')
      var day = dt.getUTCDay()
      var diff = (day + 6) % 7
      dt.setUTCDate(dt.getUTCDate() - diff)
      var weekKey = dt.toISOString().slice(0, 10)
      var entry = byWeek.get(weekKey)
      if (!entry) {
        entry = { label: weekKey, pageViews: 0, humanHits: 0, botHits: 0, visitors: 0, bytes: 0, days: 0 }
        byWeek.set(weekKey, entry)
      }
      entry.pageViews += r[1]
      entry.humanHits += r[2]
      entry.botHits += r[3]
      entry.visitors += r[4]
      entry.bytes += r[5]
      entry.days += 1
    })
    return {
      bucketed: true,
      rows: Array.from(byWeek.values()).map(function (w) {
        w.visitors = Math.round((w.visitors / w.days) * 10) / 10
        return w
      }),
    }
  }

  function getDetailWindow() {
    var windows = state.data.windows || {}
    if (state.windowKey === 'all') {
      return windows['90d'] || windows['30d'] || windows['7d'] || null
    }
    return windows[state.windowKey] || windows['30d'] || windows['7d'] || null
  }

  function renderKpis() {
    var grid = document.getElementById('kpi-grid')
    if (!grid) return
    var cards = []
    if (state.windowKey === 'all') {
      var t = state.data.allTime.totals
      var peak = t.peakDay
      cards = [
        {
          label: 'Page Views',
          value: fmtInt(t.pageViews),
          sub: 'Avg ' + t.avgDailyPageViews + ' / day · ' + fmtInt(t.humanHits) + ' human reqs',
          cls: '',
        },
        {
          label: 'Peak Day',
          value: peak ? fmtInt(peak.pageViews) : '0',
          sub: peak ? fmtDateShort(peak.date) + ' · ' + fmtInt(peak.visitors) + ' visitors' : 'No days yet',
          cls: '',
        },
        {
          label: 'Avg Daily Visitors',
          value: String(t.avgDailyVisitors),
          sub: fmtInt(t.days) + ' ' + (t.days === 1 ? 'day' : 'days') + ' tracked',
          cls: 'kpi-neutral',
        },
        {
          label: 'Bot Traffic',
          value: fmtPct(t.botShare),
          sub: fmtInt(t.botHits) + ' bot requests',
          cls: 'kpi-bot',
        },
        {
          label: 'Data Served',
          value: fmtBytes(t.bytes),
          sub: fmtInt(t.total) + ' total requests',
          cls: 'kpi-neutral',
        },
      ]
    } else {
      var w = getDetailWindow()
      if (!w) return
      var idSub = fmtInt(w.uniqueClients) + ' cookie · ' + fmtInt(w.ipOnlyVisitors) + ' IP-only'
      if (w.clientsAcrossMultipleIps > 0) {
        idSub += ' (' + w.clientsAcrossMultipleIps + ' multi-IP)'
      }
      cards = [
        {
          label: 'Page Views',
          value: fmtInt(w.pageViews),
          sub: fmtInt(w.humanHits) + ' human requests',
          cls: '',
        },
        {
          label: 'Unique Visitors',
          value: fmtInt(w.uniqueVisitors),
          sub: idSub,
          cls: '',
        },
        {
          label: 'Bot Traffic',
          value: fmtPct(w.botShare),
          sub: fmtInt(w.botHits) + ' bot requests',
          cls: 'kpi-bot',
        },
        {
          label: 'Edge Cache Hit',
          value: fmtPct(w.cacheHitRatio),
          sub: 'Cookie coverage ' + fmtPct(w.cookieCoverage),
          cls: 'kpi-neutral',
        },
        {
          label: 'Data Served',
          value: fmtBytes(w.bytes),
          sub: fmtInt(w.total) + ' total requests',
          cls: 'kpi-neutral',
        },
      ]
    }

    grid.innerHTML = cards
      .map(function (c) {
        return (
          '<div class="kpi-card ' +
          c.cls +
          '">' +
          '<p class="kpi-label">' +
          escapeHtml(c.label) +
          '</p>' +
          '<p class="kpi-value">' +
          escapeHtml(c.value) +
          '</p>' +
          '<p class="kpi-sub">' +
          escapeHtml(c.sub) +
          '</p>' +
          '</div>'
        )
      })
      .join('')
  }

  function renderDailyChart() {
    var mount = document.getElementById('daily-chart')
    var note = document.getElementById('daily-note')
    if (!mount) return
    mount.innerHTML = ''
    if (typeof d3 === 'undefined') return

    var rawRows = state.windowKey === 'all' ? state.data.allTime.days || [] : (getDetailWindow() || {}).daily || []
    if (!rawRows.length) {
      mount.innerHTML = '<p class="section-note">No daily data in this window.</p>'
      return
    }

    var prepared = bucketDailyRows(rawRows)
    var rows = prepared.rows
    if (note) {
      var unit = prepared.bucketed ? 'Weekly totals (UTC)' : 'Daily totals (UTC)'
      note.textContent = state.showBotsDaily
        ? unit + ': human page views (green) alongside bot requests (red).'
        : unit + ': human page views only.'
    }

    var W = 820
    var H = 260
    var m = { top: 14, right: 16, bottom: 34, left: 46 }
    var innerW = W - m.left - m.right
    var innerH = H - m.top - m.bottom

    var maxVal =
      d3.max(rows, function (d) {
        return state.showBotsDaily ? Math.max(d.pageViews, d.botHits) : d.pageViews
      }) || 1

    var svg = d3
      .select(mount)
      .append('svg')
      .attr('viewBox', '0 0 ' + W + ' ' + H)
      .attr('width', '100%')
      .attr('role', 'img')
      .attr('aria-label', 'Daily site traffic bar chart')

    var g = svg.append('g').attr('transform', 'translate(' + m.left + ',' + m.top + ')')

    var x = d3
      .scaleBand()
      .domain(
        rows.map(function (d) {
          return d.label
        })
      )
      .range([0, innerW])
      .padding(rows.length > 40 ? 0.15 : 0.25)

    var y = d3.scaleLinear().domain([0, maxVal]).nice().range([innerH, 0])

    g.selectAll('.grid-line')
      .data(y.ticks(5))
      .enter()
      .append('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', y)
      .attr('y2', y)
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.12)

    var maxTicks = 8
    var step = Math.max(1, Math.ceil(rows.length / maxTicks))
    var tickValues = rows
      .filter(function (_, i) {
        return i % step === 0 || i === rows.length - 1
      })
      .map(function (d) {
        return d.label
      })

    g.append('g')
      .attr('transform', 'translate(0,' + innerH + ')')
      .call(d3.axisBottom(x).tickValues(tickValues).tickFormat(fmtDateShort))

    g.append('g').call(d3.axisLeft(y).ticks(5))

    var bw = x.bandwidth()
    var groups = g
      .selectAll('.day-bar')
      .data(rows)
      .enter()
      .append('g')
      .attr('class', 'day-bar')
      .attr('transform', function (d) {
        return 'translate(' + x(d.label) + ',0)'
      })

    var barW = state.showBotsDaily ? Math.max(2, bw / 2 - 1) : Math.max(2, bw)

    groups
      .append('rect')
      .attr('x', 0)
      .attr('y', function (d) {
        return y(d.pageViews)
      })
      .attr('width', barW)
      .attr('height', function (d) {
        return Math.max(0, innerH - y(d.pageViews))
      })
      .attr('fill', 'var(--accent)')
      .attr('rx', 1.5)

    if (state.showBotsDaily) {
      groups
        .append('rect')
        .attr('x', barW + 1)
        .attr('y', function (d) {
          return y(d.botHits)
        })
        .attr('width', barW)
        .attr('height', function (d) {
          return Math.max(0, innerH - y(d.botHits))
        })
        .attr('fill', 'var(--down)')
        .attr('opacity', 0.72)
        .attr('rx', 1.5)
    }

    // Transparent hover targets spanning full column height for smooth tooltips.
    groups
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', bw)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .on('mousemove', function (event, d) {
        var title = prepared.bucketed ? 'Week of ' + d.label : d.label
        var visLabel = prepared.bucketed ? 'Avg daily visitors: ' : 'Visitors: '
        showTooltip(
          event,
          '<strong>' +
            escapeHtml(title) +
            '</strong><br>' +
            'Page views: ' +
            fmtInt(d.pageViews) +
            '<br>' +
            visLabel +
            d.visitors +
            '<br>' +
            'Human reqs: ' +
            fmtInt(d.humanHits) +
            '<br>' +
            'Bot reqs: ' +
            fmtInt(d.botHits) +
            '<br>' +
            'Data: ' +
            fmtBytes(d.bytes)
        )
      })
      .on('mouseleave', hideTooltip)
  }

  function localTzLabel() {
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date())
      var tz = parts.find(function (p) {
        return p.type === 'timeZoneName'
      })
      return tz ? tz.value : 'local time'
    } catch (e) {
      return 'local time'
    }
  }

  function fmtHourLabel(h) {
    if (h === 0) return '12a'
    if (h === 12) return '12p'
    return h < 12 ? h + 'a' : h - 12 + 'p'
  }

  function renderHourlyChart() {
    var mount = document.getElementById('hourly-chart')
    var note = document.getElementById('hourly-note')
    if (!mount) return
    mount.innerHTML = ''
    if (typeof d3 === 'undefined') return

    var w = getDetailWindow()
    if (!w || !w.hours || !w.hours.length) {
      mount.innerHTML = '<p class="section-note">No hourly data available.</p>'
      return
    }

    // Shift 24 UTC hour buckets into the viewer's local clock.
    var offsetHours = -Math.round(new Date().getTimezoneOffset() / 60)
    var shifted = Array.from({ length: 24 }, function (_, h) {
      return { hour: h, human: 0, bot: 0 }
    })
    w.hours.forEach(function (entry) {
      var utcH = Number(entry[0])
      var localH = (((utcH + offsetHours) % 24) + 24) % 24
      shifted[localH].human += entry[1] || 0
      shifted[localH].bot += entry[2] || 0
    })

    if (note) {
      note.textContent = 'Requests by hour of day (' + localTzLabel() + ').'
    }

    var W = 820
    var H = 220
    var m = { top: 12, right: 16, bottom: 30, left: 46 }
    var innerW = W - m.left - m.right
    var innerH = H - m.top - m.bottom

    var maxVal =
      d3.max(shifted, function (d) {
        return d.human + d.bot
      }) || 1

    var svg = d3
      .select(mount)
      .append('svg')
      .attr('viewBox', '0 0 ' + W + ' ' + H)
      .attr('width', '100%')
      .attr('role', 'img')
      .attr('aria-label', 'Traffic by hour of day bar chart')

    var g = svg.append('g').attr('transform', 'translate(' + m.left + ',' + m.top + ')')
    var x = d3
      .scaleBand()
      .domain(
        shifted.map(function (d) {
          return d.hour
        })
      )
      .range([0, innerW])
      .padding(0.22)
    var y = d3.scaleLinear().domain([0, maxVal]).nice().range([innerH, 0])

    g.selectAll('.grid-line')
      .data(y.ticks(4))
      .enter()
      .append('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', y)
      .attr('y2', y)
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.12)

    g.append('g')
      .attr('transform', 'translate(0,' + innerH + ')')
      .call(d3.axisBottom(x).tickValues([0, 3, 6, 9, 12, 15, 18, 21]).tickFormat(fmtHourLabel))

    g.append('g').call(d3.axisLeft(y).ticks(4))

    var groups = g
      .selectAll('.hour-bar')
      .data(shifted)
      .enter()
      .append('g')
      .attr('transform', function (d) {
        return 'translate(' + x(d.hour) + ',0)'
      })

    groups
      .append('rect')
      .attr('x', 0)
      .attr('y', function (d) {
        return y(d.human)
      })
      .attr('width', x.bandwidth())
      .attr('height', function (d) {
        return Math.max(0, innerH - y(d.human))
      })
      .attr('fill', 'var(--accent)')

    groups
      .append('rect')
      .attr('x', 0)
      .attr('y', function (d) {
        return y(d.human + d.bot)
      })
      .attr('width', x.bandwidth())
      .attr('height', function (d) {
        return Math.max(0, y(d.human) - y(d.human + d.bot))
      })
      .attr('fill', 'var(--down)')
      .attr('opacity', 0.72)

    groups
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', x.bandwidth())
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .on('mousemove', function (event, d) {
        showTooltip(
          event,
          '<strong>' +
            fmtHourLabel(d.hour) +
            ' – ' +
            fmtHourLabel((d.hour + 1) % 24) +
            '</strong><br>' +
            'Human: ' +
            fmtInt(d.human) +
            '<br>' +
            'Bot: ' +
            fmtInt(d.bot)
        )
      })
      .on('mouseleave', hideTooltip)
  }

  function renderSimpleTable(opts) {
    if (!opts.rows || !opts.rows.length) {
      return '<p class="section-note">' + escapeHtml(opts.emptyText || 'No data in this window.') + '</p>'
    }
    var max = opts.rows.reduce(function (m, r) {
      return Math.max(m, r.count)
    }, 1)
    var total =
      opts.total ||
      opts.rows.reduce(function (s, r) {
        return s + r.count
      }, 0)
    var barClass = opts.isBot ? 'inline-bar-fill bot' : 'inline-bar-fill'
    var body = opts.rows
      .map(function (r) {
        var width = Math.max(2, Math.round((r.count / max) * 100))
        var share = total > 0 ? ((r.count / total) * 100).toFixed(1) + '%' : '0.0%'
        return (
          '<tr>' +
          '<td>' +
          r.labelHtml +
          '</td>' +
          '<td class="number">' +
          fmtInt(r.count) +
          '</td>' +
          '<td class="number muted">' +
          share +
          '</td>' +
          '<td class="bar-cell"><div class="inline-bar-track"><div class="' +
          barClass +
          '" style="width:' +
          width +
          '%"></div></div></td>' +
          '</tr>'
        )
      })
      .join('')

    return (
      '<div class="table-container"><table class="stats-table compact">' +
      '<caption class="visually-hidden">' +
      escapeHtml(opts.caption) +
      '</caption>' +
      '<thead><tr>' +
      '<th scope="col">' +
      escapeHtml(opts.labelHeader) +
      '</th>' +
      '<th scope="col" class="number">' +
      escapeHtml(opts.countHeader) +
      '</th>' +
      '<th scope="col" class="number">Share</th>' +
      '<th scope="col" class="bar-cell"><span class="visually-hidden">Proportion</span></th>' +
      '</tr></thead>' +
      '<tbody>' +
      body +
      '</tbody></table></div>'
    )
  }

  function renderPagesAndReferrers() {
    var w = getDetailWindow()
    var pagesWrap = document.getElementById('pages-wrap')
    var refWrap = document.getElementById('referrers-wrap')
    if (!w) return

    if (pagesWrap) {
      var pageRows = (w.pages || []).map(function (entry) {
        var uri = entry[0]
        var label = PAGE_LABELS[uri] || uri
        var href = safePageHref(uri)
        var labelHtml = href ? '<a href="' + escapeHtml(href) + '">' + escapeHtml(label) + '</a>' : escapeHtml(label)
        return { labelHtml: labelHtml, count: entry[1] }
      })
      pagesWrap.innerHTML = renderSimpleTable({
        caption: 'Top human pages',
        labelHeader: 'Page',
        countHeader: 'Views',
        rows: pageRows,
        total: w.pageViews,
        emptyText: 'No human page views recorded in this window.',
      })
    }

    if (refWrap) {
      var refRows = (w.referrers || []).map(function (entry) {
        var host = entry[0]
        var display = host === '(direct)' ? 'Direct / Bookmark' : host
        return { labelHtml: escapeHtml(display), count: entry[1] }
      })
      refWrap.innerHTML = renderSimpleTable({
        caption: 'Top referrers',
        labelHeader: 'Source',
        countHeader: 'Views',
        rows: refRows,
        emptyText: 'No referrer data in this window.',
      })
    }
  }

  function renderBots() {
    var w = getDetailWindow()
    var summaryEl = document.getElementById('bots-summary')
    var catWrap = document.getElementById('bot-categories-wrap')
    var pathWrap = document.getElementById('bot-paths-wrap')
    if (!w) return

    if (summaryEl) {
      summaryEl.textContent =
        fmtInt(w.botHits) +
        ' automated requests (' +
        fmtPct(w.botShare) +
        ' of ' +
        fmtInt(w.total) +
        ' total requests) filtered out of human page views.'
    }

    var bots = w.bots || { categories: [], topPaths: [] }
    if (catWrap) {
      catWrap.innerHTML = renderSimpleTable({
        caption: 'Bot traffic by category',
        labelHeader: 'Bot Category',
        countHeader: 'Reqs',
        rows: (bots.categories || []).map(function (entry) {
          return { labelHtml: escapeHtml(entry[0]), count: entry[1] }
        }),
        total: w.botHits,
        isBot: true,
        emptyText: 'No bot traffic recorded in this window.',
      })
    }

    if (pathWrap) {
      pathWrap.innerHTML = renderSimpleTable({
        caption: 'Top bot-requested paths',
        labelHeader: 'Top Bot Paths',
        countHeader: 'Reqs',
        rows: (bots.topPaths || []).map(function (entry) {
          return { labelHtml: '<span class="pop-code">' + escapeHtml(entry[0]) + '</span>', count: entry[1] }
        }),
        total: w.botHits,
        isBot: true,
        emptyText: 'No bot paths recorded in this window.',
      })
    }
  }

  function renderLocations() {
    var w = getDetailWindow()
    var countriesWrap = document.getElementById('countries-wrap')
    var locWrap = document.getElementById('locations-wrap')
    if (!w) return

    var filter = state.locFilter
    var metric = function (h, b) {
      if (filter === 'human') return h
      if (filter === 'bot') return b
      return h + b
    }

    if (countriesWrap) {
      var cRows = (w.countries || [])
        .map(function (c) {
          return { code: c[0], count: metric(c[1], c[2]) }
        })
        .filter(function (c) {
          return c.count > 0
        })
        .sort(function (a, b) {
          return b.count - a.count
        })
      var cTotal = cRows.reduce(function (s, c) {
        return s + c.count
      }, 0)
      countriesWrap.innerHTML = cRows
        .slice(0, 10)
        .map(function (c) {
          var pct = cTotal > 0 ? ((c.count / cTotal) * 100).toFixed(1) + '%' : '0%'
          return (
            '<span class="country-chip">' +
            '<strong>' +
            escapeHtml(countryName(c.code)) +
            '</strong> ' +
            '<span class="muted">' +
            pct +
            ' (' +
            fmtInt(c.count) +
            ')</span>' +
            '</span>'
          )
        })
        .join('')
    }

    if (locWrap) {
      var locs = (w.locations || [])
        .map(function (l) {
          return {
            code: l.code,
            city: l.city,
            country: l.country,
            human: l.human,
            bot: l.bot,
            total: l.total,
            active: metric(l.human, l.bot),
          }
        })
        .filter(function (l) {
          return l.active > 0
        })
        .sort(function (a, b) {
          return b.active - a.active || b.total - a.total || a.code.localeCompare(b.code)
        })

      if (!locs.length) {
        locWrap.innerHTML = '<p class="section-note">No edge location data for this filter.</p>'
        return
      }

      var maxActive = locs[0].active || 1
      var barClass = filter === 'bot' ? 'inline-bar-fill bot' : 'inline-bar-fill'
      var body = locs
        .map(function (l) {
          var width = Math.max(2, Math.round((l.active / maxActive) * 100))
          var place = l.country && l.country !== 'Unknown' ? l.city + ', ' + countryName(l.country) : l.city
          return (
            '<tr>' +
            '<td>' +
            escapeHtml(place) +
            '</td>' +
            '<td><span class="pop-code">' +
            escapeHtml(l.code) +
            '</span></td>' +
            '<td class="number">' +
            fmtInt(l.human) +
            '</td>' +
            '<td class="number">' +
            fmtInt(l.bot) +
            '</td>' +
            '<td class="number">' +
            fmtInt(l.total) +
            '</td>' +
            '<td class="bar-cell"><div class="inline-bar-track"><div class="' +
            barClass +
            '" style="width:' +
            width +
            '%"></div></div></td>' +
            '</tr>'
          )
        })
        .join('')

      locWrap.innerHTML =
        '<div class="table-container"><table class="stats-table compact">' +
        '<caption class="visually-hidden">CloudFront edge locations</caption>' +
        '<thead><tr>' +
        '<th scope="col">Metro / Country</th>' +
        '<th scope="col">POP</th>' +
        '<th scope="col" class="number">Human</th>' +
        '<th scope="col" class="number">Bot</th>' +
        '<th scope="col" class="number">Total</th>' +
        '<th scope="col" class="bar-cell"><span class="visually-hidden">Share</span></th>' +
        '</tr></thead>' +
        '<tbody>' +
        body +
        '</tbody></table></div>'
    }
  }

  function renderAll() {
    var rangeLabel = document.getElementById('range-label')
    var allTimeBanner = document.getElementById('alltime-detail-banner')
    var badges = document.querySelectorAll('[data-detail-badge]')

    if (state.windowKey === 'all') {
      var at = state.data.allTime
      if (rangeLabel) {
        rangeLabel.textContent =
          at.firstDate && at.lastDate
            ? fmtDateFull(at.firstDate + 'T00:00:00Z') + ' – ' + fmtDateFull(at.lastDate + 'T00:00:00Z')
            : ''
      }
      if (allTimeBanner) allTimeBanner.hidden = false
      badges.forEach(function (el) {
        el.textContent = '90d log window'
      })
    } else {
      var w = getDetailWindow()
      if (rangeLabel) {
        rangeLabel.textContent =
          w && w.startDate && w.endDate
            ? fmtDateFull(w.startDate + 'T00:00:00Z') + ' – ' + fmtDateFull(w.endDate + 'T00:00:00Z')
            : ''
      }
      if (allTimeBanner) allTimeBanner.hidden = true
      badges.forEach(function (el) {
        el.textContent = ''
      })
    }

    renderKpis()
    renderDailyChart()
    renderPagesAndReferrers()
    renderHourlyChart()
    renderBots()
    renderLocations()
  }

  function wireControls() {
    var winGroup = document.getElementById('window-controls')
    if (winGroup) {
      winGroup.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-window]')
        if (!btn) return
        state.windowKey = btn.getAttribute('data-window')
        winGroup.querySelectorAll('button[data-window]').forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')
        })
        renderAll()
      })
    }

    var botToggle = document.getElementById('toggle-bots-daily')
    if (botToggle) {
      botToggle.addEventListener('click', function () {
        state.showBotsDaily = !state.showBotsDaily
        botToggle.setAttribute('aria-pressed', state.showBotsDaily ? 'true' : 'false')
        renderDailyChart()
      })
    }

    var locGroup = document.getElementById('location-filter')
    if (locGroup) {
      locGroup.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-loc-filter]')
        if (!btn) return
        state.locFilter = btn.getAttribute('data-loc-filter')
        locGroup.querySelectorAll('button[data-loc-filter]').forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')
        })
        renderLocations()
      })
    }
  }

  function init(data) {
    var meta = document.getElementById('analytics-meta')
    var empty = document.getElementById('analytics-empty')
    var app = document.getElementById('analytics-app')
    var hasDays = data && data.allTime && Array.isArray(data.allTime.days) && data.allTime.days.length > 0

    if (!hasDays) {
      if (meta) meta.textContent = 'Awaiting first daily log sync'
      if (empty) empty.hidden = false
      if (app) app.hidden = true
      return
    }

    state.data = data
    if (meta) {
      meta.textContent = data.updatedAt ? 'Updated ' + fmtDateFull(data.updatedAt) : 'First-party CloudFront logs'
    }
    if (empty) empty.hidden = true
    if (app) app.hidden = false

    wireControls()
    renderAll()
  }

  window.addEventListener('DOMContentLoaded', function () {
    fetch(DATA_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(init)
      .catch(function () {
        var meta = document.getElementById('analytics-meta')
        var empty = document.getElementById('analytics-empty')
        if (meta) meta.textContent = 'Analytics data unavailable'
        if (empty) empty.hidden = false
      })
  })
})()
