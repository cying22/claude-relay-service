jest.mock('../src/utils/logger', () => ({ info: jest.fn() }))
const logger = require('../src/utils/logger')
const { createDiagnostics, summarize, errorSummary } = require('../src/utils/openaiDiagnostics')
const records = () => logger.info.mock.calls.map((call) => call[1])
beforeEach(() => jest.clearAllMocks())
test('hashes are stable across object key order and detect content changes without exposing content', () => {
  const first = {
    model: 'gpt-test',
    input: [{ role: 'user', content: 'private prompt' }],
    prompt_cache_key: 'private-session'
  }
  const second = {
    prompt_cache_key: first.prompt_cache_key,
    input: first.input,
    model: first.model
  }
  expect(summarize(first).bodyHash).toBe(summarize(second).bodyHash)
  expect(summarize(first).bodyHash).not.toBe(summarize({ ...first, store: false }).bodyHash)
  expect(
    JSON.stringify(summarize(first, { authorization: 'Bearer secret', session_id: 'private-id' }))
  ).not.toMatch(/private|Bearer|secret/)
})
test('records HTTP 200 with failed events as incomplete, preserving request correlation', () => {
  const diag = createDiagnostics(
    { requestId: 'local-1', headers: {} },
    {},
    {},
    {},
    'account-1',
    true
  )
  diag.headers({
    status: 200,
    headers: { get: (key) => (key === 'x-request-id' ? 'upstream-1' : undefined) }
  })
  diag.chunk(Buffer.from('test'))
  diag.event({
    type: 'error',
    error: { type: 'server_error', code: 'server_error', message: 'private prompt sk-secret' }
  })
  diag.event({ type: 'response.failed', response: { error: { code: 'server_error' } } })
  diag.signal('upstream_end')
  const end = records().at(-1)
  expect(end).toMatchObject({
    requestId: 'local-1',
    upstreamRequestId: 'upstream-1',
    completed: false,
    failed: true,
    bytes: 4
  })
  expect(JSON.stringify(records())).not.toMatch(/private prompt|sk-secret/)
})
test('tracks completed, incomplete, and premature close distinctly', () => {
  for (const type of ['response.completed', 'response.incomplete', null]) {
    const diag = createDiagnostics({ headers: {} }, {}, {}, {}, 'a', false)
    if (type)
      diag.event({ type, response: { incomplete_details: { reason: 'max_output_tokens' } } })
    diag.signal('upstream_close', { readableEnded: false })
    expect(records().at(-1)).toMatchObject({
      completed: type === 'response.completed',
      failed: type === 'response.incomplete',
      readableEnded: false
    })
  }
})
test('omits free-form messages and bounds unknown code labels', () => {
  expect(
    errorSummary({ code: 'sensitive text with spaces', message: 'Cookie: secret' })
  ).toMatchObject({ code: null, messageLength: 14 })
  expect(JSON.stringify(errorSummary({ message: 'Cookie: secret' }))).not.toContain('Cookie')
})
test('caps event diversity and repeated terminal logging', () => {
  const diag = createDiagnostics({ headers: {} }, {}, {}, {}, 'a', false)
  for (let i = 0; i < 100; i++) diag.event({ type: `event.${i}` })
  for (let i = 0; i < 100; i++) diag.event({ type: 'error' })
  diag.signal('upstream_end')
  expect(Object.keys(records().at(-1).events).length).toBeLessThanOrEqual(40)
  expect(records().length).toBeLessThan(8)
})
