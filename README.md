# opencode-model-router

Picks the right model for every prompt, so you stop switching models by hand.

You write a prompt. A small fast model reads it, decides how hard the task is, and the turn runs
on a model that fits. Renames go to a cheap model. Architecture goes to Opus. You do nothing.

```
you type a prompt
        │
        ├── starts with "!" or is just "yes"/"ok"? ──▶ skip, no cost, no delay
        │
        ▼
  classifier  (gemini-3.5-flash-lite, ~730ms)
        │
        ▼
  tier:  light  │  standard  │  heavy
        │
        ▼
  your preferences in model-router.json
  (model missing? falls back to a live model automatically)
        │
        ▼
  the turn runs on that model  +  a toast tells you which one
```

## Why

Most teams have a lot of models available now. Picking one by hand every time is annoying, and
people forget, so they either burn a big model on a rename or use a small model on a migration.

This plugin makes the choice for you, and stays out of the way when you want control.

## What it costs

| | |
|---|---|
| Added latency | ~730ms per prompt (median), ~830ms worst case |
| Added cost | about $0.00002 per prompt |
| When it skips | `!` overrides, short prompts, "yes"/"ok"/"continue", repeated prompts |

The classifier was measured at **13/14 correct** on a set of real coding prompts.

## Requirements

- OpenCode **1.18+**
- Access to the Cloudflare OpenCode gateway (the `wellknown` login in
  `~/.local/share/opencode/auth.json`). This is the internal Cloudflare setup.

If that login is not there, the plugin does nothing and your normal model is used. It will not
break your session.

## Install

```bash
git clone git@github.com:7michele7/opencode-model-router.git
cd opencode-model-router
./install.sh
```

Then install the plugin types once, if you have not already:

```bash
cd ~/.config/opencode && npm install @opencode-ai/plugin
```

**Restart OpenCode.** Running sessions will not pick up a new plugin.

To check it worked, ask for something small like `fix the typo in the README title`. You should
see a toast such as `→ @cf/moonshotai/kimi-k2.6 · light · simple typo fix`.

### Developing on it

`./install.sh --link` symlinks the files instead of copying, so edits in the repo apply directly.

### Uninstall

```bash
rm -rf ~/.config/opencode/plugins/model-router.ts ~/.config/opencode/plugins/model-router
```

## Config

`~/.config/opencode/model-router.json` is created on your first prompt. See
[`model-router.example.json`](./model-router.example.json).

```jsonc
{
  "enabled": true,
  "classifier": "google-ai-studio/gemini-3.5-flash-lite",
  "classifierTimeoutMs": 5000,
  "toast": true,
  "toastDurationMs": 6000,
  "minPromptChars": 12,
  "skipAgents": [],
  "skipCommands": true,
  "prefixes": [">>", "!"],
  "allow": [],
  "deny": ["*robotics*", "*deep-research*"],

  "tiers": {
    "light":    ["cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6", "anthropic/claude-haiku-4-5"],
    "standard": ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-5"],
    "heavy":    ["anthropic/claude-opus-5", "anthropic/claude-opus-4-6"]
  }
}
```

| Field | What it does |
|---|---|
| `enabled` | Set to `false` to turn routing off without uninstalling |
| `classifier` | The model that reads your prompt. Must be a gateway model id |
| `classifierTimeoutMs` | If the classifier is slow, give up and use your normal model |
| `toast` | Show which model was picked. Keep this on (see Caveats) |
| `toastDurationMs` | How long the toast stays up |
| `minPromptChars` | Prompts shorter than this are not routed |
| `skipAgents` | Agent names that should never be routed, e.g. `["review"]` |
| `skipCommands` | Leave slash commands alone. On by default |
| `prefixes` | Strings that mark an override. Longest match wins |
| `allow` | Only use these models. Empty means all of them |
| `deny` | Never use these models |
| `tiers` | Which model you want for each tier, best first |

`allow` and `deny` accept exact ids or globs: `anthropic/*`, `*haiku*`, `*-mini`.

### Only use models you like

By default the router can use every model OpenCode can reach, and new models are picked up
automatically. If you want a smaller set, use `allow`:

```jsonc
"allow": ["anthropic/*", "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6"]
```

This applies to everything: tier preferences, the automatic fallback, and `!` overrides. If a
tier preference is not in the allow list, the router falls through to the next one you listed,
and then to a live model inside the allow list.

### The tiers

| Tier | For | Examples |
|---|---|---|
| `light` | Mechanical edits and plain questions | rename, typo, version bump, "what does this regex do" |
| `standard` | Normal feature work in one area | add a component, write a test, fix a described bug |
| `heavy` | Real reasoning | architecture, migrations, cross-cutting refactors, security review, unknown bugs |

When the classifier is unsure between two tiers, it picks the higher one.

## Slash commands are left alone

If you run a command like `/review-mr`, the router does not touch it. Commands often pin their
own `model:` or `agent:` on purpose, and overriding that would break them.

This covers commands that run in a child session too (`subtask: true`), and any agent that pins
its own model. A prompt you type yourself *after* a command in the same session is still routed
normally.

Set `"skipCommands": false` if you want commands routed as well.

## Overrides

Put these at the start of your prompt.

| Prefix | Effect |
|---|---|
| `>>heavy`, `>>standard`, `>>light` | Force a tier |
| `>>opus`, `>>haiku`, `>>grok`, ... | Force any model whose id contains that text |
| `>>off` | Skip routing, use your normal model |

```
>>heavy rename this variable          # you know it is subtle, force the big model
>>light explain this whole system     # you just want a quick answer
>>off do whatever                     # router stays out of it
```

Overrides never call the classifier, so they add no delay.

### Why `>>` and not `!`

Do not use `!` in the TUI. OpenCode binds `!` as the first character to **shell mode**, so the
prompt never reaches this plugin:

```js
// packages/tui/src/component/prompt/index.tsx
enabled: store.mode === "normal" && input?.visualCursor.offset === 0
bindings: [{ key: "!", desc: "Shell mode", ... }]
```

`@` and `/` are taken too (file autocomplete and slash commands). `>>` is free.

`!` still works for HTTP API clients, so it stays in the default `prefixes` list. Change
`prefixes` if you want something else:

```jsonc
"prefixes": ["++"]
```

## Caveats

**The model name in the TUI footer will be wrong.** OpenCode only refreshes it when you switch
sessions, so it keeps showing your default. The toast is your real signal. Do not turn it off
unless you do not care which model ran.

The toast appears in the **top right corner** of the TUI and stays for 6 seconds. Raise
`toastDurationMs` if you keep missing it.

**Routing is per turn, not sticky.** Every prompt is classified again. This is on purpose, so a
follow-up architecture question is not stuck on a cheap model. Short replies like "yes" are
skipped so they stay on whatever ran last.

**Subagents are routed too.** Add their names to `skipAgents` if you do not want that.

## Tests

```bash
node --experimental-strip-types --no-warnings test/core.test.ts
```

43 tests, no network needed. They run against a real captured provider payload in
`test/fixtures/providers.json`, so they check the actual data shape OpenCode returns.

## How it works

The interesting part is which hook to use.

`chat.params` looks like the hook for changing the model, but it is not. By the time it runs,
the provider SDK is already chosen, and its output has no model field.

`chat.message` is the one that works. OpenCode saves your user message, and then the assistant
turn reads the model back **out of that saved message**. `chat.message` runs right before the
save, so changing `output.message.model` there changes which model runs the turn.

```
createUserMessage()
  ├─ plugin hook "chat.message"   ← we change the model here
  ├─ save the user message         ← our change is written
  └─ assistant turn reads the model back from the saved message
```

The model list is not hardcoded. It comes from `client.config.providers()` at runtime, which is
every model your OpenCode can actually reach, with cost, context size and capabilities. The
router drops anything that cannot do tool calls, anything that outputs images, audio or video,
and duplicate dated ids like `claude-sonnet-4-5-20250929`. New models show up on their own.

Because of that, `tiers` only holds your preferences. If a model you listed is gone, the router
picks the newest live model in the same price band instead. Nothing to maintain when models change.

### Layout

```
src/model-router.ts          the plugin: config, auth, classifier call, the hook
src/model-router/core.ts     pure logic: catalog, filters, tier resolution, parsing
test/core.test.ts            tests for core.ts
```

`core.ts` lives in a subfolder on purpose. OpenCode loads `plugins/*.ts` but does not look inside
subfolders, so it is imported as a normal module instead of being treated as a second plugin.
