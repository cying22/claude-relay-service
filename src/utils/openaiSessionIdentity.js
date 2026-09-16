const crypto = require('crypto')

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function identifier(value) {
  return typeof value === 'string' && value.trim() && !/[\r\n]/.test(value) ? value.trim() : null
}

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

// Content fallback groups cache routing only; it must never restore another
// request's previous_response_id or opaque turn state from a shared cache.
function resolveSession(headers = {}, body = {}, { allowContextFallback = true } = {}) {
  const candidates = [
    ['session_id', headers.session_id],
    ['conversation_id', headers.conversation_id],
    ['x-session-id', headers['x-session-id']],
    ['body.session_id', body.session_id],
    ['body.conversation_id', body.conversation_id],
    ['prompt_cache_key', body.prompt_cache_key]
  ]
  for (const [source, value] of candidates) {
    const raw = identifier(value)
    if (raw) return { source, raw }
  }

  // A response continuation already has its own identity. Don't infer it from
  // the new input alone. Short greetings are also too ambiguous to merge.
  if (!allowContextFallback || body.previous_response_id || body.conversation) return null
  const items = Array.isArray(body.input) ? body.input : body.messages
  if (!Array.isArray(items)) return null
  const index = items.findIndex((item) => item.role === 'user')
  if (index < 0) return null
  const first = items[index]
  const text =
    typeof first.content === 'string'
      ? first.content
      : (Array.isArray(first.content) ? first.content : [])
          .filter((block) => ['input_text', 'text'].includes(block.type))
          .map((block) => block.text || '')
          .join('')
  if (text.trim().length < 128) return null
  const anchor = canonical({
    model: body.model,
    instructions: body.instructions,
    tools: body.tools,
    reasoning: body.reasoning,
    text: body.text,
    prefix: items.slice(0, index + 1)
  })
  return { source: 'context', raw: `context:${digest(anchor)}` }
}

function scopeSession(keyId, identity) {
  return identity ? digest(['crs-session-v1', keyId, identity.raw]) : null
}

function upstreamIdentity(keyId, accountId, raw) {
  return digest(['crs-upstream-v1', keyId, accountId, raw])
}

function applySession(headers, body, keyId, accountId, identity) {
  if (!identity) return
  headers.session_id = upstreamIdentity(keyId, accountId, identity.raw)
  const conversation = identifier(headers.conversation_id)
  if (conversation) {
    headers.conversation_id = upstreamIdentity(keyId, accountId, conversation)
  }
  for (const field of ['session_id', 'conversation_id', 'prompt_cache_key']) {
    const raw = identifier(body[field])
    if (raw) body[field] = upstreamIdentity(keyId, accountId, raw)
  }
  if (!identifier(body.prompt_cache_key)) body.prompt_cache_key = headers.session_id
}

module.exports = { resolveSession, scopeSession, applySession }
