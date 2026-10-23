/**
 * Mount this package's RPC channel where the harness lets it be.
 *
 * The official route is `connection.rpc.handle(prefix, dispatch)`. In the
 * harness build the Desktop app currently ships, that call reaches the
 * Connection service through a context that cannot see `webServer`, so the
 * registration throws and no route is ever added — every browser POST on the
 * prefix then falls through to the host's 405.
 *
 * So the official registration is tried first, and a throw falls back to
 * mounting the same prefix from this plugin's own `webServer` child context.
 * Admission, envelope shape, body cap and response envelopes mirror the
 * Connection adapter, so the channel behaves the same whichever path mounted
 * it.
 *
 * @module dsh-merge-preset/route
 */

/** The channel the browser half calls; must match `lib/client.js`. */
export const CHANNEL = '/merge-preset'

/** Mirror of the Connection adapter's default body cap. Our payloads are tiny. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

/** Mirror of the Connection adapter's endpoint segment grammar. */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/

const INVALID_RPC_ID = 'invalid-request'

/**
 * Mount `dispatch` on {@link CHANNEL}.
 *
 * @param ctx - a context that injects `connection`.
 * @param dispatch - `(method, payload) => Promise<result>` handler.
 */
export function mountChannel(ctx, dispatch) {
  try {
    ctx.connection.rpc.handle(CHANNEL, async (method, payload) => dispatch(method, payload))
    return
  } catch {
    // The registration body threw before adding a route, so nothing is
    // half-mounted. Fall through to the direct web route.
  }

  const connection = ctx.connection
  ctx.inject(['webServer'], (web) => {
    const webServer = web.get('webServer')
    web.effect(() => webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: async (req, res) => {
        const rejection = connection.requestRejection?.(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await handleHttp(req, res, dispatch)
      },
    }), `dsh-merge-preset: ${CHANNEL} web route`)
  })
}

/**
 * One node:http exchange, answered in the Connection envelope.
 *
 * @param req - incoming request.
 * @param res - response this function owns.
 * @param dispatch - the channel handler.
 */
async function handleHttp(req, res, dispatch) {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const method = endpointOf(url.pathname)
  if (req.method !== 'POST' || method === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }

  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    res.writeHead(415, { 'content-type': 'text/plain' })
    res.end('content type must be application/json')
    return
  }

  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.byteLength
    if (received > MAX_REQUEST_BODY_BYTES) {
      res.writeHead(413, { connection: 'close' })
      res.end()
      req.destroy()
      return
    }
    chunks.push(chunk)
  }

  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('body is not JSON')
    return
  }

  const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : INVALID_RPC_ID
  if (body?.type !== 'client-request' || body?.method !== method) {
    reply(res, rpcId, {
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message' },
    })
    return
  }

  try {
    reply(res, rpcId, await dispatch(method, body.payload))
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(`handler failure: ${String(error?.message ?? error)}`)
  }
}

/**
 * The endpoint after the channel prefix, or undefined when it is not one valid
 * segment.
 *
 * @param pathname - request path.
 * @returns the method name.
 */
function endpointOf(pathname) {
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(CHANNEL.length + 1)
  const segments = endpoint.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || !SEGMENT.test(s))) return undefined
  return endpoint
}

/**
 * Write one `server-response` envelope.
 *
 * @param res - response to complete.
 * @param rpcId - correlation id echoed back.
 * @param result - handler result.
 */
function reply(res, rpcId, result) {
  const payload = JSON.stringify({ type: 'server-response', rpcId, result })
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(payload)
}
