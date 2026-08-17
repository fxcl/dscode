import { LoginAnswer, LoginState } from '../shared/types'
import { authenticateProvider } from '@thinkany/dscode-core'

/**
 * Native login flow for the DSCode runtime, run IN-PROCESS against
 * `@thinkany/dscode-core`'s `authenticateProvider` (the same code path
 * `dscode login` uses) with a GRAPHICAL AuthInteraction: prompts surface as
 * the existing LoginState machine (waiting_for_input / waiting_for_select /
 * waiting_for_browser) and answers come back through AUTH_ANSWER_LOGIN —
 * exactly like the current-profile OmpLoginFlow, so the renderer needs no
 * changes.
 *
 * Differences from the CLI: `dscode login` demands a TTY; the GUI cannot
 * provide one, so the flow rides the library instead of a child process.
 * OAuth providers (openai-codex, anthropic subscription, …) open the browser
 * through the notify(auth_url) event — never auto-opened, matching the GUI's
 * user-initiated URL policy. API-key providers (deepseek) are rejected here:
 * they use the direct file-backed setApiKey path, not a login flow.
 */

/** Structural mirror of pi-ai's AuthPrompt (avoid a direct pi-ai dependency). */
interface AuthPromptLike {
  signal?: { aborted: boolean }
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

/** Structural mirror of pi-ai's AuthEvent. */
type AuthEventLike =
  | { type: 'info'; message: string }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }
  | { type: 'progress'; message: string }

/** Login prompts allow 10 minutes of user time. */
const PROMPT_TIMEOUT_MS = 10 * 60_000

interface PendingPrompt {
  requestId: string
  resolve: (value: string) => void
  reject: (error: Error) => void
  /** label → option id for select prompts (state carries labels, core wants ids). */
  selectIds?: Map<string, string>
}

export class DscodeLoginFlow {
  private providerId = ''
  private finished = false
  private aborted = false
  private pending: PendingPrompt | null = null

  constructor(private readonly onState: (state: LoginState) => void) {}

  get active(): boolean {
    return !this.finished
  }

  private setState(state: LoginState): void {
    this.onState(state)
  }

  async start(providerId: string): Promise<void> {
    this.providerId = providerId
    if (providerId === 'deepseek') {
      this.finish({
        status: 'failed',
        providerId,
        message: 'DeepSeek uses an API key — enter it directly instead of a login flow.'
      })
      return
    }
    this.setState({ status: 'starting', providerId })
    try {
      await authenticateProvider(providerId as never, {
        prompt: (prompt: AuthPromptLike) => this.bridgePrompt(prompt),
        notify: (event: AuthEventLike) => this.bridgeNotify(event)
      })
      this.finish({ status: 'connected', providerId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.aborted || /cancel/i.test(message)) {
        this.finish({ status: 'cancelled', providerId })
      } else {
        this.finish({ status: 'failed', providerId, message })
      }
    }
  }


  private bridgePrompt(prompt: AuthPromptLike): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.aborted || prompt.signal?.aborted) {
        reject(new Error('Login cancelled'))
        return
      }
      const requestId = `dscode-login-${Date.now()}`
      const selectIds =
        prompt.type === 'select' && prompt.options
          ? new Map(prompt.options.map((o) => [o.label, o.id]))
          : undefined
      this.pending = { requestId, resolve, reject, selectIds }
      if (prompt.type === 'select') {
        this.setState({
          status: 'waiting_for_select',
          providerId: this.providerId,
          requestId,
          title: prompt.message,
          options: (prompt.options ?? []).map((o) => o.label),
          timeoutMs: PROMPT_TIMEOUT_MS
        })
      } else {
        // text / secret / manual_code — all render as the input box.
        this.setState({
          status: 'waiting_for_input',
          providerId: this.providerId,
          requestId,
          title: prompt.message,
          placeholder: prompt.placeholder,
          timeoutMs: PROMPT_TIMEOUT_MS
        })
      }
    })
  }

  private bridgeNotify(event: AuthEventLike): void {
    if (this.finished) return
    switch (event.type) {
      case 'auth_url':
        this.setState({
          status: 'waiting_for_browser',
          providerId: this.providerId,
          url: event.url,
          launchUrl: event.url,
          instructions: event.instructions
        })
        break
      case 'device_code':
        this.setState({
          status: 'waiting_for_browser',
          providerId: this.providerId,
          url: event.verificationUri,
          launchUrl: event.verificationUri,
          instructions: `Code: ${event.userCode}`
        })
        break
      case 'info':
      case 'progress':
        this.setState({
          status: 'verifying',
          providerId: this.providerId,
          message: event.message
        })
        break
    }
  }

  /** Answer the pending prompt; returns false when nothing is pending. */
  answer(answer: LoginAnswer): boolean {
    if (this.finished || !this.pending) return false
    if ('cancelled' in answer) {
      this.pending.reject(new Error('Login cancelled'))
      this.pending = null
      this.cancel()
      return true
    }
    if ('value' in answer && typeof answer.value === 'string') {
      const { resolve, selectIds } = this.pending
      this.pending = null
      resolve(selectIds?.get(answer.value) ?? answer.value)
      return true
    }
    // AuthPrompt has no confirm flavor; anything else is a protocol mismatch.
    return false
  }

  cancel(): void {
    if (this.finished) return
    this.aborted = true
    this.pending?.reject(new Error('Login cancelled'))
    this.pending = null
    this.finish({ status: 'cancelled', providerId: this.providerId })
  }

  private finish(state: LoginState): void {
    this.finished = true
    this.pending = null
    this.setState(state)
  }
}