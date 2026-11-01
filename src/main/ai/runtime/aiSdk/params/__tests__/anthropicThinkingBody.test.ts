import { describe, expect, it } from 'vitest'

import { createThinkingBodyFetch } from '../anthropicThinkingBody'

describe('createThinkingBodyFetch', () => {
  // A final body can acquire a raw cap after SDK serialization or encounter a smaller SDK ceiling.
  it.each([
    { max_tokens: 64000, budget: 100000, cap: 128000, expectedMax: 64000, expectedBudget: 63999 },
    { max_tokens: 8000, budget: 4000, cap: 4096, expectedMax: 4096, expectedBudget: 4000 },
    { max_tokens: 1025, budget: 1024, cap: undefined, expectedMax: 1025, expectedBudget: 1024 },
    { max_tokens: 1024, budget: 2048, cap: undefined, expectedMax: 1024, expectedBudget: undefined },
    { max_tokens: 4096, budget: undefined, cap: undefined, expectedMax: 4096, expectedBudget: 1024 }
  ])(
    'enforces the serialized pair %j without changing the response stream',
    async ({ max_tokens, budget, cap, expectedMax, expectedBudget }) => {
      let body: unknown
      const response = new Response('data: test\n\n', { headers: { 'content-type': 'text/event-stream' } })
      const inner: typeof globalThis.fetch = async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return response
      }
      const actual = await createThinkingBodyFetch(inner, cap)('https://example.com', {
        method: 'POST',
        body: JSON.stringify({
          max_tokens,
          thinking: { type: 'enabled', budget_tokens: budget },
          stream: true,
          metadata: { keep: 1 }
        })
      })
      expect(body).toEqual({
        max_tokens: expectedMax,
        ...(expectedBudget !== undefined && { thinking: { type: 'enabled', budget_tokens: expectedBudget } }),
        stream: true,
        metadata: { keep: 1 }
      })
      expect(actual).toBe(response)
      expect(await actual.text()).toBe('data: test\n\n')
    }
  )

  it.each([
    { thinking: { type: 'enabled', budget_tokens: 2048 } },
    { max_tokens: '1024', thinking: { type: 'enabled', budget_tokens: 2048 } },
    { max_tokens: 4096, thinking: { type: 'adaptive' } },
    { max_tokens: 4096, thinking: { type: 'disabled' } },
    { max_tokens: 4096, thinking: { type: 'invalid' } },
    ...['2048', null, -1, 512, 8191.5].map((budget_tokens) => ({
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens }
    }))
  ])('preserves missing limits and invalid or non-enabled thinking: %j', async (body) => {
    let actual: unknown
    const inner: typeof globalThis.fetch = async (_input, init) => {
      actual = JSON.parse(String(init?.body))
      return new Response(null, { status: 204 })
    }
    await createThinkingBodyFetch(inner, undefined)('https://example.com', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    expect(actual).toEqual(body)
  })

  it.each([
    { method: 'GET', body: '{"max_tokens":1024}' },
    { method: 'POST', body: 'not-json' },
    { method: 'POST', body: 'null' },
    { method: 'POST', body: '[]' },
    { method: 'POST', body: new ReadableStream() }
  ])('forwards unsupported request shapes unchanged: %j', async (init) => {
    let forwarded: RequestInit | undefined
    const inner: typeof globalThis.fetch = async (_input, requestInit) => {
      forwarded = requestInit
      return new Response(null, { status: 204 })
    }
    await createThinkingBodyFetch(inner, 512)('https://example.com', init)
    expect(forwarded).toBe(init)
  })

  it('reuses by inner fetch and cap with bounded least-recently-used retention', () => {
    const inner: typeof globalThis.fetch = async () => new Response(null, { status: 204 })
    const first = createThinkingBodyFetch(inner, undefined)
    for (let cap = 2000; cap < 2009; cap++) createThinkingBodyFetch(inner, cap)
    expect(createThinkingBodyFetch(inner, undefined)).toBe(first)
    const oldest = createThinkingBodyFetch(inner, 2000)
    createThinkingBodyFetch(inner, 3000)
    expect(createThinkingBodyFetch(inner, undefined)).toBe(first)
    expect(createThinkingBodyFetch(inner, 2000)).toBe(oldest)
    const other: typeof globalThis.fetch = async () => new Response(null, { status: 204 })
    expect(createThinkingBodyFetch(other, undefined)).not.toBe(first)
    for (let cap = 4000; cap < 4010; cap++) createThinkingBodyFetch(inner, cap)
    expect(createThinkingBodyFetch(inner, undefined)).not.toBe(first)
  })
})
