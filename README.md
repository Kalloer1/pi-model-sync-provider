# pi-model-sync-provider

Sync **one** Pi provider's model list against the provider's own live catalog.

Pi ships static per-provider model seeds and can refresh its curated catalog from
pi.dev. Custom gateways (new-api, one-api, LiteLLM, OpenRouter clones, local
proxies) are not covered by that, so their model lists drift: the provider adds
models you never see, and retires models that stay in your `models.json` until a
request fails.

This extension adds one command that fixes exactly one provider at a time. It
never touches the other providers in your `models.json`.

```
/model-sync <provider>              sync that provider
/model-sync <provider> --dry-run    report only, write nothing
/model-sync                         pick a provider from a list
```

## What it does

1. **Fetch** `GET {baseUrl}/models` using that provider's own credentials
   (`apiKey`, `authHeader`, `headers`). The live list is the only authority on
   what the provider serves.
2. **Delete** local entries that are absent from the live list.
3. **Match** every live id against [models.dev](https://models.dev) by the
   **last path segment** of the id — `kilo/cohere/north-mini-code:free` matches
   on `north-mini-code:free`. When several namespaces carry the same model name,
   the alphabetically first namespace wins.
4. **Overwrite** `contextWindow`, `maxTokens`, `reasoning`, `input`, and `cost`
   from the models.dev entry when it matches. When it does not match, the
   existing entry is kept **byte for byte** — no defaults are invented over
   hand-tuned values.
5. **Add** live models that are missing locally, using models.dev data when
   available and conservative defaults (128k context, 16k output, text-only, no
   reasoning, no cost) when not.
6. **Back up** to `models.json.bak-<ISO timestamp>`, write, then hot-reload the
   model registry so `/model` reflects the new list without a restart.

## Safety rails

A provider outage must never wipe your catalog, so the whole sync aborts and
leaves `models.json` untouched when:

- the list request fails (bad port, auth error, timeout, 5xx), or
- the list request succeeds but returns **zero** models.

Deletion only ever happens after a successful, non-empty discovery.

`--dry-run` prints the same report without writing anything.

## Install

```bash
pi install git:github.com/Kalloer1/pi-model-sync-provider
```

Or from a local checkout:

```bash
pi install ./pi-model-sync-provider
```

Or drop `extensions/model-sync.ts` into `~/.pi/agent/extensions/` and skip the
package entirely — that directory is discovered automatically.

## Example

```
/model-sync age

model-sync age: live 28 个
  +0 新增  ~13 更新  -32 删除  =15 保留
  删除: opencode-zen-free/beam-free, qoder/qfmodel, grok-4.6, ...
  models.dev 未匹配 15 个（保留原值）: glm-flash, kilo/kilo-auto/free, ...
已写入 models.json（备份 models.json.bak-20261018T032945Z），模型清单已热加载
```

## Matching caveat

Last-segment matching is deliberately simple, and it has a known cost: ids that
end in a generic segment collide. `kilo/kilo-auto/free` and
`kilo/openrouter/free` both reduce to `free`, which is not a model name in
models.dev, so both stay on their existing hand-written parameters. In practice
this means aggregator-prefixed free-tier ids are kept as-is rather than
refreshed. That is the intended trade-off: keeping correct existing values beats
inventing wrong ones.

## Cost caveat

`cost` is copied from models.dev, which lists **upstream list prices**, not the
price your gateway charges. A reseller marking models down (or up) will make Pi's
cost accounting differ from your actual bill. The extension reports models with
no cost data instead of writing a fabricated zero.

## Cache

The models.dev catalog (~5 MB) is cached in
`<agent-dir>/model-sync-modelsdev.json` for 6 hours. Delete the file to force a
refetch.

## License

MIT
