// Anonymous first-party client id.
//
// Sets a long-lived `db_cid` cookie, which CloudFront records in its access
// logs (the `cs(Cookie)` field) next to `c-ip`. That makes page requests
// attributable without a beacon, a third-party script, or a consent banner.
//
// localStorage mirrors the value, so clearing cookies alone does not mint a
// new id: a returning visitor keeps counting as one person. Nothing here is
// sent anywhere; the only consumer is the CDN log line.
;(function () {
  var KEY = 'db_cid'
  var MAX_AGE = 60 * 60 * 24 * 365 // one year
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  function mint() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID()
    }
    // Older Safari / insecure context: shape a v4 UUID by hand so the id
    // stays the same length and satisfies UUID_RE on the next page load.
    var hex = ''
    for (var i = 0; i < 32; i++) {
      hex += Math.floor(Math.random() * 16).toString(16)
    }
    return (
      hex.slice(0, 8) +
      '-' +
      hex.slice(8, 12) +
      '-4' +
      hex.slice(13, 16) +
      '-' +
      ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16) +
      hex.slice(17, 20) +
      '-' +
      hex.slice(20, 32)
    )
  }

  try {
    var match = document.cookie.match(/(?:^|;\s*)db_cid=([^;]+)/)
    var existing = match ? decodeURIComponent(match[1]) : null
    var cid = UUID_RE.test(existing || '') ? existing : null

    if (!cid) {
      var stored = null
      try {
        stored = localStorage.getItem(KEY)
      } catch (e) {
        stored = null
      }
      cid = UUID_RE.test(stored || '') ? stored : mint()
    }

    if (cid !== existing) {
      document.cookie = KEY + '=' + encodeURIComponent(cid) + '; Max-Age=' + MAX_AGE + '; Path=/; Secure; SameSite=Lax'
    }

    try {
      localStorage.setItem(KEY, cid)
    } catch (e) {
      // Storage unavailable; the cookie alone still identifies the visitor.
    }
  } catch (e) {
    // Private browsing or cookies disabled: requests still land in the
    // CloudFront logs with an IP, they just carry no client id.
  }
})()
