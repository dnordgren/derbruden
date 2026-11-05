// Shared Discord webhook helpers. watch-trades.mjs owned the only sender
// with 429-retry handling; the playoff poster used a bare fetch. Everyone
// posts through here now.
export async function postDiscordMessage(fetchImpl, webhookUrl, payload) {
  const send = () =>
    fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  const res = await send()
  if (res.status === 429) {
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : {}
    const waitMs = (body.retry_after ?? Number(res.headers.get('retry-after')) ?? 1) * 1000
    await new Promise(r => setTimeout(r, Math.min(waitMs, 10000)))
    const retry = await send()
    if (!retry.ok && retry.status !== 204) {
      throw new Error(`Discord retry failed with HTTP ${retry.status}`)
    }
    return
  }
  if (!res.ok && res.status !== 204) throw new Error(`Discord failed with HTTP ${res.status}`)
}

// Bust scraper caches (Discord unfurls) so each week renders fresh.
export function discordPageUrl(pageUrl, season, week) {
  return `${pageUrl}?x=${season}-w${week || 0}`
}
