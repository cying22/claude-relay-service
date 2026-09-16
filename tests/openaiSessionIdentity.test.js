const { resolveSession, scopeSession, applySession } = require('../src/utils/openaiSessionIdentity')

const body = () => ({
  model: 'gpt-6-astra',
  instructions: 'stable instructions',
  tools: [{ name: 'read', type: 'function' }],
  input: [
    { role: 'user', content: 'Please analyze the following project specification. '.repeat(5) }
  ]
})

test('native mode only uses explicit client identity', () => {
  expect(resolveSession({}, body(), { allowContextFallback: false })).toBeNull()
  expect(
    resolveSession({}, { ...body(), prompt_cache_key: 'native' }, { allowContextFallback: false })
  ).toEqual({ source: 'prompt_cache_key', raw: 'native' })
})

test('explicit session wins over context and cache key', () => {
  expect(
    resolveSession(
      { session_id: 'one', conversation_id: 'two' },
      { ...body(), prompt_cache_key: 'three' }
    )
  ).toEqual({ source: 'session_id', raw: 'one' })
})

test.each([
  [{ conversation_id: 'a' }, {}, 'conversation_id'],
  [{ 'x-session-id': 'a' }, {}, 'x-session-id'],
  [{}, { session_id: 'a' }, 'body.session_id'],
  [{}, { conversation_id: 'a' }, 'body.conversation_id'],
  [{}, { prompt_cache_key: 'a' }, 'prompt_cache_key']
])('supports explicit identity aliases', (headers, payload, source) => {
  expect(resolveSession(headers, payload)).toEqual({ raw: 'a', source })
})

test('appending turns preserves fallback without modifying input', () => {
  const first = body()
  const next = body()
  next.input.push({ role: 'assistant', content: 'answer' }, { role: 'user', content: 'continue' })
  expect(resolveSession({}, next)).toEqual(resolveSession({}, first))
  expect(next.input).toHaveLength(3)
})

test('different first message or tools changes fallback', () => {
  const first = resolveSession({}, body())
  const changed = body()
  changed.input[0].content += 'different task'
  expect(resolveSession({}, changed)).not.toEqual(first)
  changed.tools.push({ name: 'write', type: 'function' })
  expect(resolveSession({}, changed)).not.toEqual(first)
})

test.each([
  { input: [{ role: 'user', content: 'continue' }] },
  { input: 'hello' },
  { ...body(), previous_response_id: 'resp-one' },
  { ...body(), conversation: 'conversation-one' },
  { input: [{ role: 'assistant', content: 'answer' }] }
])('does not guess ambiguous or incremental contexts', (payload) => {
  expect(resolveSession({}, payload)).toBeNull()
})

test('isolates different keys and accounts, stays stable on repeated requests', () => {
  const identity = { raw: 'same-client-id' }
  expect(scopeSession('key1', identity)).not.toBe(scopeSession('key2', identity))
  const build = (key, account) => {
    const headers = { conversation_id: identity.raw }
    const payload = { prompt_cache_key: identity.raw }
    applySession(headers, payload, key, account, identity)
    return { headers, payload }
  }
  expect(build('key1', 'a')).toEqual(build('key1', 'a'))
  expect(build('key1', 'a')).not.toEqual(build('key2', 'a'))
  expect(build('key1', 'a')).not.toEqual(build('key1', 'b'))
  expect(build('key1', 'a').headers.session_id).toBe(build('key1', 'a').payload.prompt_cache_key)
})

test('never invents turn state or previous response IDs for inferred sessions', () => {
  const payload = body()
  const headers = {}
  applySession(headers, payload, 'key', 'account', resolveSession({}, payload))
  expect(headers.session_id).toBeTruthy()
  expect(headers['x-codex-turn-state']).toBeUndefined()
  expect(payload.previous_response_id).toBeUndefined()
})
