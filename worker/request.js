import encrypt from '../util/crypto.js'
import config from '../util/config.json'

const { APP_CONF } = config
const SPECIAL_STATUS_CODES = new Set([201, 302, 400, 502, 800, 801, 802, 803])

const osMap = {
  pc: {
    os: 'pc',
    appver: '3.1.17.204416',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    channel: 'netease',
  },
  iphone: {
    os: 'iPhone OS',
    appver: '9.0.90',
    osver: '16.2',
    channel: 'distribution',
  },
}

const userAgentMap = {
  weapi:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  api: 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
}

function cookieToJson(cookie) {
  if (!cookie) return {}
  return Object.fromEntries(
    cookie
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        return index === -1
          ? [part, '']
          : [part.slice(0, index), part.slice(index + 1)]
      }),
  )
}

function cookieObjToString(cookie) {
  return Object.entries(cookie)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('; ')
}

function createHeaderCookie(header) {
  return Object.entries(header)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('; ')
}

function processCookieObject(cookie, uri) {
  const randomId = crypto.randomUUID().replaceAll('-', '')
  const os = osMap[cookie.os] || osMap.pc
  const processed = {
    ...cookie,
    __remember_me: 'true',
    ntes_kaola_ad: '1',
    _ntes_nuid: cookie._ntes_nuid || randomId,
    _ntes_nnid: cookie._ntes_nnid || `${randomId},${Date.now()}`,
    WNMCID: cookie.WNMCID || `worker.${Date.now()}.01.0`,
    WEVNSM: cookie.WEVNSM || '1.0.0',
    osver: cookie.osver || os.osver,
    deviceId: cookie.deviceId || '',
    os: cookie.os || os.os,
    channel: cookie.channel || os.channel,
    appver: cookie.appver || os.appver,
  }

  if (!uri.includes('login')) {
    processed.NMTID ||= crypto.randomUUID().replaceAll('-', '')
  }

  return processed
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const value = headers.get('set-cookie')
  return value ? [value] : []
}

export default async function createWorkerRequest(uri, data, options = {}) {
  const headers = new Headers(options.headers || {})
  let cookie = options.cookie || {}
  if (typeof cookie === 'string') cookie = cookieToJson(cookie)
  cookie = processCookieObject(cookie, uri)

  let url = ''
  let encryptedData = ''
  let cryptoMode = options.crypto || (APP_CONF.encrypt ? 'eapi' : 'api')
  const csrfToken = cookie.__csrf || ''

  if (options.realIP) {
    headers.set('X-Real-IP', options.realIP)
    headers.set('X-Forwarded-For', options.realIP)
  }

  switch (cryptoMode) {
    case 'weapi':
      headers.set('Referer', APP_CONF.domain)
      headers.set('User-Agent', options.ua || userAgentMap.weapi)
      data.csrf_token = csrfToken
      encryptedData = encrypt.weapi(data)
      url = `${APP_CONF.domain}/weapi/${uri.slice(5)}`
      break
    case 'eapi':
    case 'api': {
      const header = {
        osver: cookie.osver,
        deviceId: cookie.deviceId,
        os: cookie.os,
        appver: cookie.appver,
        versioncode: cookie.versioncode || '140',
        mobilename: cookie.mobilename || '',
        buildver: cookie.buildver || String(Date.now()).slice(0, 10),
        resolution: cookie.resolution || '1920x1080',
        __csrf: csrfToken,
        channel: cookie.channel,
        requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
      }
      if (cookie.MUSIC_U) header.MUSIC_U = cookie.MUSIC_U
      if (cookie.MUSIC_A) header.MUSIC_A = cookie.MUSIC_A

      headers.set('Cookie', createHeaderCookie(header))
      headers.set('User-Agent', options.ua || userAgentMap.api)

      if (cryptoMode === 'eapi') {
        data.header = header
        data.e_r = options.e_r ?? data.e_r ?? APP_CONF.encryptResponse
        encryptedData = encrypt.eapi(uri, data)
        url = `${APP_CONF.apiDomain}/eapi/${uri.slice(5)}`
      } else {
        encryptedData = data
        url = APP_CONF.apiDomain + uri
      }
      break
    }
    default:
      throw new Error(`Unsupported crypto mode in Workers runtime: ${cryptoMode}`)
  }

  headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8')
  headers.set('Cookie', headers.get('Cookie') || cookieObjToString(cookie))

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(encryptedData).toString(),
  })

  let body
  if (cryptoMode === 'eapi' && data.e_r) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    body = encrypt.eapiResDecrypt(Buffer.from(bytes).toString('hex').toUpperCase())
  } else {
    const text = await response.text()
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (body && typeof body === 'object' && 'code' in body) {
    body.code = Number(body.code)
  }

  let status = Number(body?.code || response.status)
  if (SPECIAL_STATUS_CODES.has(body?.code)) status = 200
  if (!(status > 100 && status < 600)) status = 400

  const cookies = getSetCookies(response.headers).map((value) =>
    value.replace(/\s*Domain=[^;]+;?/i, ''),
  )

  const answer = { status, body, cookie: cookies }
  if (status === 200) return answer
  throw answer
}
