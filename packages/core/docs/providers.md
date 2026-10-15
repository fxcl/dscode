# Providers and credentials (BYOK)

DSCode is bring-your-own-key. The `deepseek` provider slot accepts any
OpenAI-compatible endpoint, which is how third-party gateways are used.

## Pointing at a custom gateway

```powershell
$env:DEEPSEEK_BASE_URL = "https://api.minimax.cn/v1"   # any OpenAI-compatible host
$env:DEEPSEEK_API_KEY  = "sk-..."                       # that gateway's key
$env:DSCODE_TRANSPORT  = "chat"                         # chat-completions wire
dscode
```

Prefer `chat` transport for non-DeepSeek gateways; `responses` is DeepSeek's
default wire. The gateway error surfaces verbatim - a 401 there means the
key does not belong to that endpoint.

## Credential storage

Three places a credential can live, checked in this order by request time:

1. Environment variable (`DEEPSEEK_API_KEY` etc.) when nothing is stored.
2. Stored credential (`dscode login <provider>` writes `~/.dscode/auth.json`
   and the OS keyring). **A stored credential takes precedence over the
   environment variable** - remove it with `dscode logout <provider>` if you
   want the env var to win.
3. Keyring-only credentials: the first-run gate (`ensureFirstRunAuth`) checks
   env vars and auth.json but not the keyring, so keep `DEEPSEEK_API_KEY`
   exported if your key lives only in the keyring.

`dscode status` lists every provider with configured / stored state.

## Cost visibility

`/status` reports tokens, cache hit rate, and estimated cost (model-rate
estimate, not a bill). `~/.dscode/settings.json` can store
`fallbackProvider`/`fallbackModel`; `/fallback` manages them.
