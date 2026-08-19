import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LoginState, LoginAnswer } from '../../shared/types'

vi.mock('@thinkany/dscode-core', () => ({
  authenticateProvider: vi.fn()
}))

import { DscodeLoginFlow } from '../dscodeLoginFlow'
import { authenticateProvider } from '@thinkany/dscode-core'

interface AuthInteraction {
  prompt: (p: {
    type: 'text' | 'secret' | 'select' | 'manual_code'
    message: string
    placeholder?: string
    options?: ReadonlyArray<{ id: string; label: string }>
    signal?: { aborted: boolean }
  }) => Promise<string>
  notify: (e: {
    type: string
    message?: string
    url?: string
    instructions?: string
    userCode?: string
    verificationUri?: string
  }) => void
}

describe('DscodeLoginFlow', () => {
  let states: LoginState[]
  let interaction: AuthInteraction
  let resolveAuth: (() => void) | null
  let rejectAuth: ((err: Error) => void) | null

  beforeEach(() => {
    vi.clearAllMocks()
    states = []
    resolveAuth = null
    rejectAuth = null
    ;(authenticateProvider as unknown as { mockImplementation: (fn: (id: string, i: AuthInteraction) => Promise<void>) => void }).mockImplementation(
      async (_id: string, i: AuthInteraction) => {
        interaction = i
        return new Promise<void>((res, rej) => {
          resolveAuth = res
          rejectAuth = rej
        })
      }
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeFlow(): DscodeLoginFlow {
    return new DscodeLoginFlow((s) => states.push(s))
  }

  function last(): LoginState {
    return states[states.length - 1]
  }


  it('rejects deepseek immediately', async () => {
    makeFlow().start('deepseek')
    await Promise.resolve()
    expect(last().status).toBe('failed')
  })

  it('emits starting then waiting_for_input for text prompt', async () => {
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    // Don't await the prompt — just trigger it to check state transitions.
    void interaction.prompt({ type: 'text', message: 'Token:' })
    await Promise.resolve()
    expect(states.some((s) => s.status === 'starting')).toBe(true)
    expect(last().status).toBe('waiting_for_input')
    // Clean up: answer the prompt then resolve auth.
    f.answer({ value: 'x' })
    resolveAuth?.()
    await p
  })

  it('answers text prompt and connects', async () => {
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    const pp = interaction.prompt({ type: 'secret', message: 'Key:' })
    expect(f.answer({ value: 'secret123' })).toBe(true)
    await expect(pp).resolves.toBe('secret123')
    resolveAuth?.()
    await p
    expect(last().status).toBe('connected')
  })

  it('maps select label to option id', async () => {
    const f = makeFlow()
    const p = f.start('anthropic')
    await Promise.resolve()
    const pp = interaction.prompt({
      type: 'select',
      message: 'Account:',
      options: [{ id: 'a1', label: 'Work' }, { id: 'a2', label: 'Home' }]
    })
    expect(last().status).toBe('waiting_for_select')
    f.answer({ value: 'Home' })
    await expect(pp).resolves.toBe('a2')
    resolveAuth?.()
    await p
  })

  it('rejects duplicate select labels', async () => {
    const f = makeFlow()
    const p = f.start('anthropic')
    await Promise.resolve()
    const pp = interaction.prompt({
      type: 'select',
      message: 'Pick:',
      options: [{ id: 'a', label: 'Dup' }, { id: 'b', label: 'Dup' }]
    })
    await expect(pp).rejects.toThrow('Duplicate option label')
    // The real authenticateProvider would catch the rejected prompt and
    // re-throw; simulate that by rejecting the auth promise.
    rejectAuth?.(new Error('Duplicate option label in login prompt: "Dup"'))
    await p
    expect(last().status).toBe('failed')
  })

  it('cancels pending prompt', async () => {
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    const pp = interaction.prompt({ type: 'text', message: 'Token:' })
    f.cancel()
    await expect(pp).rejects.toThrow('Login cancelled')
    expect(last().status).toBe('cancelled')
    resolveAuth?.()
    await p
  })

  it('answer cancelled triggers cancel', async () => {
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    const pp = interaction.prompt({ type: 'text', message: 'Token:' })
    expect(f.answer({ cancelled: true } as LoginAnswer)).toBe(true)
    await expect(pp).rejects.toThrow('Login cancelled')
    resolveAuth?.()
    await p
  })

  it('returns false when no pending prompt', () => {
    expect(makeFlow().answer({ value: 'x' })).toBe(false)
  })

  it('times out when user never answers', async () => {
    vi.useFakeTimers()
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    const pp = interaction.prompt({ type: 'text', message: 'Token:' })
    vi.advanceTimersByTime(10 * 60_000 + 1)
    await expect(pp).rejects.toThrow('timed out')
    expect(last().status).toBe('failed')
    vi.useRealTimers()
    // The timeout finish() sets finished=true; reject to settle start().
    rejectAuth?.(new Error('Login timed out'))
    await p
  })

  it('clears timeout when answered', async () => {
    vi.useFakeTimers()
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    const pp = interaction.prompt({ type: 'text', message: 'Token:' })
    f.answer({ value: 'tok' })
    await expect(pp).resolves.toBe('tok')
    vi.advanceTimersByTime(10 * 60_000 + 1)
    expect(last().status).not.toBe('failed')
    vi.useRealTimers()
    resolveAuth?.()
    await p
  })

  it('bridges auth_url to waiting_for_browser', async () => {
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    interaction.notify({ type: 'auth_url', url: 'https://a.com', instructions: 'Go' })
    expect(last().status).toBe('waiting_for_browser')
    resolveAuth?.()
    await p
  })

  it('bridges device_code with user code', async () => {
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    interaction.notify({ type: 'device_code', userCode: 'XYZ', verificationUri: 'https://d.com' })
    expect(last().status).toBe('waiting_for_browser')
    const s = last()
    if (s.status === 'waiting_for_browser') {
      expect(s.instructions).toBe('Code: XYZ')
    }
    resolveAuth?.()
    await p
  })

  it('bridges progress to verifying', async () => {
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    interaction.notify({ type: 'progress', message: 'Working...' })
    expect(last().status).toBe('verifying')
    resolveAuth?.()
    await p
  })

  it('reports failed on auth error', async () => {
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    rejectAuth?.(new Error('Network down'))
    await p
    expect(last().status).toBe('failed')
  })

  it('reports cancelled on cancellation error', async () => {
    const f = makeFlow()
    const p = f.start('openai-codex')
    await Promise.resolve()
    rejectAuth?.(new Error('User cancelled'))
    await p
    expect(last().status).toBe('cancelled')
  })
})
