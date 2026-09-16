const crypto = require('crypto')
const logger = require('./logger')

// A process-local fallback keeps tests safe; production uses a stable server secret.
const secret = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex')
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    )
  }
  return value
}
function fingerprint(value) {
  if (value === undefined || value === null || value === '') return null
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
function label(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value) ? value : null
}
function identities(headers = {}, body = {}) {
  const metadata = body.client_metadata || {}
  return Object.fromEntries(
    [
      ['headerSession', headers.session_id],
      ['headerConversation', headers.conversation_id],
      ['headerXSession', headers['x-session-id']],
      ['turnState', headers['x-codex-turn-state']],
      ['turnMetadata', headers['x-codex-turn-metadata']],
      ['bodySession', body.session_id],
      ['bodyConversation', body.conversation_id],
      ['cacheKey', body.prompt_cache_key],
      ['previousResponse', body.previous_response_id],
      ['clientSession', metadata.session_id],
      ['clientThread', metadata.thread_id],
      ['clientTurn', metadata.turn_id]
    ].map(([key, value]) => [key, fingerprint(value)])
  )
}
function summarize(body = {}, headers = {}) {
  return {
    bodyHash: fingerprint(body),
    bodyBytes: Buffer.byteLength(JSON.stringify(body)),
    model: label(body.model),
    stream: body.stream !== false,
    reasoningEffort: label(body.reasoning?.effort),
    serviceTier: label(body.service_tier),
    inputItems: Array.isArray(body.input) ? body.input.length : null,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    identities: identities(headers, body)
  }
}
function errorSummary(error = {}) {
  // Never log free-form upstream messages: they may quote user input or credentials.
  return {
    type: label(error.type),
    code: label(error.code),
    messageHash: fingerprint(error.message),
    messageLength: typeof error.message === 'string' ? error.message.length : 0
  }
}
function createDiagnostics(req, originalBody, outgoingBody, headers, accountId, nativePassthrough) {
  const started = Date.now()
  const base = {
    requestId: req.requestId || crypto.randomUUID(),
    accountHash: crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 16),
    nativePassthrough
  }
  let bytes = 0
  let firstByteMs = null
  let completed = false
  let failed = false
  let upstreamRequestId = null
  const events = Object.create(null)
  function emit(stage, data) {
    try {
      logger.info('OpenAI diagnostic', {
        ...base,
        stage,
        upstreamRequestId,
        elapsedMs: Date.now() - started,
        ...data
      })
    } catch (_) {
      /* Diagnostics must not affect forwarding. */
    }
  }
  const incoming = summarize(originalBody, req.headers)
  const outgoing = summarize(outgoingBody, headers)
  emit('request', { incoming, outgoing, bodyUnchanged: incoming.bodyHash === outgoing.bodyHash })
  return {
    headers(response) {
      const get = (key) => response.headers?.get?.(key) || response.headers?.[key]
      upstreamRequestId = label(get('x-request-id')) || label(get('openai-request-id'))
      emit('headers', {
        status: response.status,
        turnStateHash: fingerprint(get('x-codex-turn-state'))
      })
    },
    chunk(chunk) {
      bytes += Buffer.byteLength(chunk)
      if (firstByteMs === null) firstByteMs = Date.now() - started
    },
    event(event) {
      const type = label(event?.type) || 'unknown'
      if (
        Object.keys(events).length < 36 ||
        events[type] ||
        ['error', 'response.failed', 'response.incomplete', 'response.completed'].includes(type)
      )
        events[type] = (events[type] || 0) + 1
      if (type === 'response.completed') completed = true
      if (['error', 'response.failed', 'response.incomplete'].includes(type)) failed = true
      if (
        ['error', 'response.failed', 'response.incomplete', 'response.completed'].includes(type) &&
        events[type] <= 3
      ) {
        emit('event', {
          eventType: type,
          error: errorSummary(event.error || event.response?.error || event),
          incompleteReason: label(event.response?.incomplete_details?.reason),
          responseHash: fingerprint(event.response?.id),
          inputTokens: event.response?.usage?.input_tokens,
          outputTokens: event.response?.usage?.output_tokens,
          cachedTokens: event.response?.usage?.input_tokens_details?.cached_tokens
        })
      }
    },
    signal(signal, extra = {}) {
      emit('lifecycle', {
        signal,
        completed,
        failed,
        bytes,
        firstByteMs,
        events: { ...events },
        ...extra
      })
    },
    error(error) {
      emit('transport_error', errorSummary(error))
    }
  }
}
module.exports = { createDiagnostics, summarize, errorSummary }
