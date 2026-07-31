# opencode-model-router

Picks the right model for every prompt, so you stop switching models by hand.

You write a prompt. A small fast model reads it, decides how hard the task is, and the turn runs
on a model that fits. Renames go to a cheap model. Architecture goes to Opus. You do nothing.

```
you type a prompt
        │
        ├── an override, or just "yes"/"ok"? ──────▶ skip, no cost, no delay
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

## What it costs

| | |
|---|---|
| Added latency | ~730ms per prompt (median), ~830ms worst case |
| Added cost | about $0.00002 per prompt |
| When it skips | `>>` overrides, short prompts, "yes"/"ok"/"continue", repeated prompts |

Measured at **17/18** on a set of real coding prompts.

## Requirements

- OpenCode **1.18+**
- Access to the Cloudflare OpenCode gateway. The plugin looks for a `wellknown` entry in
  `~/.local/share/opencode/auth.json` — if you can use OpenCode with Cloudflare-hosted models,
  you already have this.

If that login is not there, the plugin does nothing and your normal model is used. It will not
break your session.

## Install

```bash
git clone git@github.com:7michele7/opencode-model-router.git
cd opencode-model-router
./install.sh --link
```

`--link` symlinks the plugin files instead of copying them. With symlinks, `git pull` is all you
ever need to update — no reinstall. Without `--link`, you have to re-run `./install.sh` after
every pull.

Then install the plugin types once, if you have not already:

```bash
cd ~/.config/opencode && npm install @opencode-ai/plugin
```

**Restart OpenCode.** Running sessions will not pick up a new plugin.

To check it worked, ask for something small like `fix the typo in the README title`. You should
see a toast such as `→ gpt-4o-mini · light · simple typo fix`.

### Updating

```bash
git pull
```

That's it if you installed with `--link`. If you used plain `./install.sh`, re-run it after pulling.

### Developing on it

Same as using it — `--link` means your edits in the repo apply directly without reinstalling.

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
  "classifier": [
    "google-ai-studio/gemini-3.5-flash-lite",
    "anthropic/claude-haiku-4-5"
  ],
  "classifierTimeoutMs": 5000,
  "toast": true,
  "toastDurationMs": 6000,
  "minPromptChars": 12,
  "skipAgents": [],
  "skipCommands": true,
  "prefixes": [">>"],
  "onClassifierFailure": "default",
  "allow": [],
  "deny": ["*robotics*", "*deep-research*"],

  "tiers": {
    "light":    ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5"],
    "standard": ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-5"],
    "heavy":    ["anthropic/claude-opus-5", "anthropic/claude-opus-4-6"]
  }
}
```

| Field | What it does |
|---|---|
| `enabled` | Set to `false` to turn routing off without uninstalling |
| `classifier` | The model that reads your prompt. Must be a gateway model id |
| `classifierTimeoutMs` | Per model in the chain, so a 2-model chain can wait twice this long |
| `onClassifierFailure` | What to do when the whole chain fails. `"default"` (leave your model alone) or a tier |
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
"allow": ["anthropic/*", "openai/gpt-4o-mini"]
```

This applies to everything: tier preferences, the automatic fallback, and `>>` overrides. If a
tier preference is not in the allow list, the router falls through to the next one you listed,
and then to a live model inside the allow list.

### The tiers

Tiers describe **how much work a request needs**, not how it is worded.

| Tier | For | Examples |
|---|---|---|
| `light` | Self-contained. Needs no file, repo or history | rename, typo, version bump, "what does useMemo do" |
| `standard` | One area of feature work, or anything that must read the project first | add a component, write a test, "what did we do so far", "update the README" |
| `heavy` | Real reasoning | architecture, migrations, cross-cutting refactors, security review, unknown bugs |

A short prompt is not automatically light, rewriting an existing file is never light, and ties
round up. Judging on grammar instead of work required was worth 6 misclassifications out of 18.

## Slash commands are left alone

If you run a command like `/review-mr`, the router does not touch it. Commands often pin their
own `model:` or `agent:` on purpose, and overriding that would break them.

This covers commands that run in a child session too (`subtask: true`), and any agent that pins
its own model. A prompt you type yourself *after* a command in the same session is still routed
normally.

Set `"skipCommands": false` if you want commands routed as well.

## Overrides

Put these at the start of your prompt.

| Prefix | Effect | Sticky? |
|---|---|---|
| `>>heavy`, `>>standard`, `>>light` | Set the tier for the rest of the session | yes |
| `>>opus`, `>>haiku`, `>>grok`, ... | Hold that exact model for the rest of the session | yes |
| `>>off` | Clear whatever is set and go back to auto | clears it |

```
>>heavy rename this variable          # subtle work — and the session stays heavy
>>opus keep going                     # every later turn stays on opus too
>>off do whatever                     # back to automatic routing
```

Overrides never call the classifier, so they add no delay.

A session is in exactly one of three states, and setting one clears the others:

```
auto            classify every prompt          (default)
tier floor      >>heavy / >>standard / >>light  classifier may go up, never down
model pin       >>opus / >>haiku / ...          one exact model, classifier not called
```

A model pin skips classification, so it also removes the ~700ms it costs. If a pinned model
disappears from the catalog the pin is dropped and the session goes back to automatic routing.

## Sticky tiers

A tier override is a **floor**, not a one-off: `tier = max(classified_tier, session_floor)`. The
classifier can move a session up but never back down.

```
>>heavy how should I structure this?     opus-5      floor := heavy
  "use the second option"                opus-5      classified light → held at heavy
  "ok now write it"                      opus-5      classified standard → held at heavy
>>off                                    (cleared)   free routing again
```

This exists because complexity is inherited from the conversation, not carried by your prompt. When
a big model asks you a question your reply is short — *"yes, option 2"* — and a per-message
classifier reads that as trivial. Rather than trying to detect replies, the tier simply cannot
decrease on its own.

Prompts too short to classify keep the floor too, so `"yes"` does not fall back to your default
model. Floors are per session.

## When the classifier fails

If `classifier` is an array the router tries each model in order. `classifierTimeoutMs` applies to
**each** one, so a two-model chain can spend twice that long before giving up.

Pick the fallback from a **different provider**. A same-provider fallback tends to fail at the same
moment as the primary, which is the only moment it exists for. Measured on the gateway:

| Model | Accuracy | p50 | p90 | max |
|---|---|---|---|---|
| `gemini-3.5-flash-lite` (primary) | 17/18 | 799ms | 848ms | 853ms |
| `claude-haiku-4-5` (fallback) | 16/18 | 889ms | 1149ms | 1552ms |
| `gemini-2.5-flash-lite` (old fallback) | 16/18 | 713ms | 2958ms | **8070ms** |
| `gpt-4o-mini` | 17/18 | 1558ms | 3825ms | **19077ms** |

The old fallback lost a coin flip against its own 5s timeout, so it often never answered.

When the whole chain fails the router **does not guess a tier**. It leaves `output.message.model`
alone and the turn runs on the model you selected:

```
                            ┌─ session has a >>tier floor?  ── hold that floor
whole classifier chain fails ┤
                            └─ otherwise                    ── your own model, untouched
```

This is the only behaviour that cannot be worse than not installing the router at all. Guessing
`standard` quietly downgrades anyone whose default is stronger than that — an Opus user would spend
an outage on Sonnet and only find out from a toast.

The failure toast is an **error** variant, it is forced through even with `toast: false`, and it
carries the reason from every model in the chain:

```
classifier down · using your own model · gemini-3.5-flash-lite: HTTP 401 · claude-haiku-4-5: HTTP 401
```

Set `"onClassifierFailure": "standard"` (or any tier) if you would rather have a guess than your own
default. A failed classification is never cached and never becomes a session floor, so one bad
minute does not follow you around for the rest of the session.

Single-string `classifier` still works for backward compatibility.

## Auto-discovery

Set `autoDiscovery: true` and the router will ignore your `tiers` list and pick models from the live
catalog automatically.

```jsonc
{
  "autoDiscovery": true,
  "maxModelsPerTier": 3
}
```

It groups models by cost band — cheapest go to `light`, middle to `standard`, priciest to `heavy` —
and keeps the newest model from each provider in each band. Up to `maxModelsPerTier` per tier.

This is **opt-in** and off by default. Turn it on when you do not want to maintain a model list.
Your `allow` and `deny` filters still apply, so you can exclude providers you do not want.

## Caveats

**The model name in the TUI footer will be wrong.** OpenCode only refreshes it when you switch
sessions, so it keeps showing your default. The toast is your real signal. Do not turn it off
unless you do not care which model ran.

It appears **top right** and stays 6 seconds. Raise `toastDurationMs` if you keep missing it.

**Routing is per turn, but cannot go backwards.** Every prompt is classified again, so a follow-up
architecture question is never stuck on a cheap model. It just cannot *drop* on its own. See
[Sticky tiers](#sticky-tiers).

**Do not add `!` or `@` or `/` to `prefixes`.** The TUI binds them to shell mode and autocomplete,
so they never reach a plugin.

**Subagents are routed too.** Add their names to `skipAgents` if you do not want that.

**A classifier outage is loud on purpose.** The error toast ignores `toast: false`, because the one
thing you need to know is when the router has stopped routing.

## Tests

```bash
node --experimental-strip-types --no-warnings test/core.test.ts
```

92 tests, no network needed. They run against a real captured provider payload in
`test/fixtures/providers.json`, so they check the actual data shape OpenCode returns.

The classifier taxonomy has regression tests asserting the light tier is not defined by grammar.

## How it works

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

Classifier decisions are cached per session, keyed on `sessionID + prompt`. The same wording in a
different session is classified again, because the right tier depends on what came before it.

### Layout

```
src/model-router.ts          the plugin: config, auth, classifier call, the hook
src/model-router/core.ts     pure logic: catalog, filters, tier resolution, parsing
test/core.test.ts            tests for core.ts
```

`core.ts` lives in a subfolder on purpose. OpenCode loads `plugins/*.ts` but does not look inside
subfolders, so it is imported as a normal module instead of being treated as a second plugin.
