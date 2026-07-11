import songDetail from '../module/song_detail.js'
import createWorkerRequest from './request.js'

const modules = {
  song_detail: songDetail,
}

function json(body, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(body), { ...init, headers })
}

async function parseParams(request) {
  const url = new URL(request.url)
  const params = Object.fromEntries(url.searchParams)

  if (request.method === 'POST') {
    const type = request.headers.get('content-type') || ''
    if (type.includes('application/json')) {
      Object.assign(params, await request.json())
    } else if (type.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData()
      for (const [key, value] of form.entries()) params[key] = String(value)
    }
  }

  return params
}

export default {
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        ok: true,
        runtime: 'cloudflare-workers',
        routes: ['/api/song/detail'],
      })
    }

    if (!url.pathname.startsWith('/api/')) {
      return json({ code: 404, message: 'Not Found' }, { status: 404 })
    }

    const routeName = url.pathname
      .slice('/api/'.length)
      .replace(/^\/+|\/+$/g, '')
      .replaceAll('/', '_')

    const handler = modules[routeName]
    if (!handler) {
      return json(
        { code: 404, message: `Unsupported Workers route: ${url.pathname}` },
        { status: 404 },
      )
    }

    const params = await parseParams(request)
    params.cookie ||= request.headers.get('cookie') || ''

    try {
      const result = await handler(params, createWorkerRequest)
      const headers = new Headers()
      for (const cookie of result.cookie || []) headers.append('Set-Cookie', cookie)
      return json(result.body, { status: result.status, headers })
    } catch (error) {
      const status = Number(error?.status) || 500
      const body = error?.body || {
        code: status,
        message: error instanceof Error ? error.message : String(error),
      }
      return json(body, { status })
    }
  },
}
