// End-to-end coverage for the classifier-failure path.
//
// Exercises the real chat.message hook with a stubbed global fetch, so there is no network, no
// gateway token, and no dependency on a live classifier. HOME is redirected at a temp dir before
// the plugin is imported (it resolves every path from homedir() at module load), so a run cannot
// touch a real ~/.config/opencode/model-router.json.
//
// Run: node --experimental-strip-types --no-warnings test/failure.e2e.ts

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const providers = JSON.parse(readFileSync(join(here, "fixtures/providers.json"), "utf8")).providers

// ---------------------------------------------------------------- fake HOME
const home = mkdtempSync(join(tmpdir(), "model-router-e2e-"))
mkdirSync(join(home, ".config", "opencode"), { recursive: true })
mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true })
process.env.HOME = home
process.env.USERPROFILE = home

writeFileSync(
  join(home, ".local", "share", "opencode", "auth.json"),
  JSON.stringify({ "https://gateway.test": { type: "wellknown", token: "not-a-real-token" } }),
)

const CONFIG = join(home, ".config", "opencode", "model-router.json")
const writeConfig = (extra: Record<string, unknown> = {}) =>
  writeFileSync(CONFIG, JSON.stringify({ classifierTimeoutMs: 300, ...extra }, null, 2))

writeConfig()

// ------------------------------------------------------------- fetch stub
type Step = { status: number; tier?: string; hang?: boolean }
let script: Step[] = []
let classifierCalls = 0

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url?.url ?? url)

  // Gateway discovery: hand back a provider whose baseURL ends in /compat.
  if (u.endsWith("/config/opencode.json")) {
    return jsonResponse({ provider: { gw: { options: { baseURL: "https://gateway.test/compat" } } } })
  }

  if (u.includes("/chat/completions")) {
    classifierCalls++
    const step = script.shift() ?? { status: 401 }

    if (step.hang) {
      // A server that answers far too late, so the plugin's AbortSignal.timeout wins the race.
      // The ref'd setTimeout is load-bearing: AbortSignal.timeout() uses an *unref'd* timer, so
      // with only an abort listener pending Node drains the loop and exits 13 (unsettled
      // top-level await) rather than running the test.
      return new Promise((resolve, reject) => {
        const late = setTimeout(() => resolve(new Response("too late", { status: 200 })), 10_000)
        init.signal?.addEventListener?.("abort", () => {
          clearTimeout(late)
          const err: any = new Error("The operation was aborted due to timeout")
          err.name = "TimeoutError"
          reject(err)
        })
      })
    }

    if (step.status !== 200) return new Response("nope", { status: step.status })
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ tier: step.tier, why: "stubbed" }) } }],
    })
  }

  throw new Error(`unexpected fetch: ${u}`)
}) as typeof fetch

// Imported only after HOME is redirected and fetch is stubbed.
const { ModelRouter } = await import("../src/model-router.ts")
const { buildCatalog, resolveTier, DEFAULTS } = await import("../src/model-router/core.ts")

const catalog = buildCatalog(providers, DEFAULTS)
const expected = (tier: "light" | "standard" | "heavy") => resolveTier(tier, catalog, DEFAULTS)?.modelID

// ------------------------------------------------------------------ harness
let toasts: { message: string; variant: string }[] = []

const makeClient = (): any => ({
  config: { providers: async () => ({ data: { providers } }) },
  tui: {
    showToast: async ({ body }: any) => {
      toasts.push({ message: body.message, variant: body.variant })
      return {}
    },
  },
  app: { agents: async () => ({ data: [{ name: "build", model: null }] }) },
  session: { get: async () => ({ data: { parentID: undefined } }) },
})

const SENTINEL = { providerID: "sentinel", modelID: "the-model-the-user-picked" }
const turn = (text: string) => ({ message: { model: { ...SENTINEL } }, parts: [{ type: "text", text }] })

let passed = 0
let failed = 0
const check = (name: string, cond: boolean, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${!cond && detail ? `  -> ${detail}` : ""}`)
}
const errorToasts = () => toasts.filter((t) => t.variant === "error")

// A long prompt that clears minPromptChars and is not a continuation.
const PROMPT_A = "restructure the session store so reconnects reuse the existing socket"
const PROMPT_B = "rename the helper in utils.ts from fmt to formatBytes"

// ============================================================ 1. fails open
console.log("\n— every classifier down, no override —")
let hooks: any = await ModelRouter({ client: makeClient() } as any)
toasts = []
script = [{ status: 401 }, { status: 503 }]
let out = turn(PROMPT_A)
await hooks["chat.message"]({ sessionID: "ses_open", agent: "build" }, out)

check("leaves the user's own model in place", out.message.model.modelID === SENTINEL.modelID, out.message.model.modelID)
check("does not rewrite providerID either", out.message.model.providerID === SENTINEL.providerID)
check("raises an error-variant toast", errorToasts().length === 1, JSON.stringify(toasts))
check("names every model that failed", /401/.test(errorToasts()[0]?.message ?? "") && /503/.test(errorToasts()[0]?.message ?? ""), errorToasts()[0]?.message)
check("tries the whole chain before giving up", classifierCalls === 2, String(classifierCalls))

// ================================== 2. a failure must not stick to the session
// Regression: the fabricated "standard" tier used to be written to the session floor, and floors
// only ratchet up — so one transient 401 pinned the session to >= standard long after recovery.
console.log("\n— a transient failure must not outlive the outage —")
toasts = []
script = [{ status: 200, tier: "light" }]
const recovered = turn(PROMPT_B)
await hooks["chat.message"]({ sessionID: "ses_open", agent: "build" }, recovered)

check(
  "routes light once the classifier recovers",
  recovered.message.model.modelID === expected("light"),
  `${recovered.message.model.modelID} (wanted ${expected("light")})`,
)
check(
  "is not held at standard by the earlier failure",
  recovered.message.model.modelID !== expected("standard"),
  recovered.message.model.modelID,
)
check("no error toast once recovered", errorToasts().length === 0, JSON.stringify(toasts))

// ============================ 3. failure is not written to the decision cache
// Fresh session on purpose: ses_open now carries an inferred floor from turn 2, which changes
// which branch a failure takes (see test 8).
console.log("\n— the same prompt is retried, not served a cached guess —")
toasts = []
classifierCalls = 0
script = [{ status: 401 }, { status: 401 }, { status: 401 }, { status: 401 }]
const first = turn(PROMPT_A)
await hooks["chat.message"]({ sessionID: "ses_cache", agent: "build" }, first)
const again = turn(PROMPT_A)
await hooks["chat.message"]({ sessionID: "ses_cache", agent: "build" }, again)
check("re-consults the classifier for a previously failed prompt", classifierCalls === 4, String(classifierCalls))
check("still on the user's own model", again.message.model.modelID === SENTINEL.modelID, again.message.model.modelID)

// ==================================== 4. an explicit floor beats "default"
console.log("\n— >>heavy is an instruction, not a guess —")
toasts = []
const ovr = turn(">>heavy how should the migration be staged")
await hooks["chat.message"]({ sessionID: "ses_floor", agent: "build" }, ovr)
check("override applies without calling the classifier", ovr.message.model.modelID === expected("heavy"), ovr.message.model.modelID)
check("override raises no error toast", errorToasts().length === 0)

toasts = []
script = [{ status: 401 }, { status: 401 }]
const held = turn(PROMPT_B)
await hooks["chat.message"]({ sessionID: "ses_floor", agent: "build" }, held)
check("holds the floor through a failure", held.message.model.modelID === expected("heavy"), held.message.model.modelID)
check("does not drop the floor to the user's default", held.message.model.modelID !== SENTINEL.modelID)
check("still reports the failure", errorToasts().length === 1, JSON.stringify(toasts))
check("says it is holding the tier", /hold/i.test(errorToasts()[0]?.message ?? ""), errorToasts()[0]?.message)

// The floor is rewritten on every successful turn, so whatever marks it as user-requested has to
// survive that rewrite — otherwise >>heavy silently decays into an inferred floor after one turn.
toasts = []
script = [{ status: 200, tier: "light" }]
const ratchet = turn(PROMPT_B)
await hooks["chat.message"]({ sessionID: "ses_floor", agent: "build" }, ratchet)
check("a light turn is still held at the heavy floor", ratchet.message.model.modelID === expected("heavy"), ratchet.message.model.modelID)

toasts = []
script = [{ status: 401 }, { status: 401 }]
const stillHeld = turn(PROMPT_A)
await hooks["chat.message"]({ sessionID: "ses_floor", agent: "build" }, stillHeld)
check(
  "the override survives a successful turn and still wins on failure",
  stillHeld.message.model.modelID === expected("heavy"),
  `${stillHeld.message.model.modelID} — >>heavy decayed into an inferred floor`,
)

// ================================================= 5. a hang is not silence
console.log("\n— a hung classifier reports, it does not stall silently —")
toasts = []
script = [{ hang: true, status: 0 }, { hang: true, status: 0 }]
const hung = turn("work out why the worker cold-starts on every request")
await hooks["chat.message"]({ sessionID: "ses_hang", agent: "build" }, hung)
check("keeps the user's model after a timeout", hung.message.model.modelID === SENTINEL.modelID, hung.message.model.modelID)
check("surfaces the timeout as an error", errorToasts().length === 1, JSON.stringify(toasts))
check("names the timeout as the cause", /timeout/i.test(errorToasts()[0]?.message ?? ""), errorToasts()[0]?.message)

// ============================== 6. toast: false must not silence a failure
console.log("\n— toast: false hides routing, never failures —")
writeConfig({ toast: false })
hooks = await ModelRouter({ client: makeClient() } as any)
toasts = []
script = [{ status: 200, tier: "light" }]
const quiet = turn(PROMPT_B)
await hooks["chat.message"]({ sessionID: "ses_quiet", agent: "build" }, quiet)
check("routine routing is silent", toasts.length === 0, JSON.stringify(toasts))
check("but still routes", quiet.message.model.modelID === expected("light"), quiet.message.model.modelID)

toasts = []
script = [{ status: 401 }, { status: 401 }]
const loud = turn(PROMPT_A)
await hooks["chat.message"]({ sessionID: "ses_quiet2", agent: "build" }, loud)
check("a failure still gets through", errorToasts().length === 1, JSON.stringify(toasts))

// ========================= 7. opting back into the old forced-tier behaviour
console.log("\n— onClassifierFailure: standard is still available —")
writeConfig({ onClassifierFailure: "standard" })
hooks = await ModelRouter({ client: makeClient() } as any)
toasts = []
script = [{ status: 401 }, { status: 401 }]
const forced = turn(PROMPT_A)
await hooks["chat.message"]({ sessionID: "ses_forced", agent: "build" }, forced)
check("forces the configured tier", forced.message.model.modelID === expected("standard"), forced.message.model.modelID)
check("and still says so loudly", errorToasts().length === 1, JSON.stringify(toasts))

// garbage normalises to "default" rather than throwing or guessing
writeConfig({ onClassifierFailure: "banana" })
hooks = await ModelRouter({ client: makeClient() } as any)
toasts = []
script = [{ status: 401 }, { status: 401 }]
const junk = turn(PROMPT_A)
await hooks["chat.message"]({ sessionID: "ses_junk", agent: "build" }, junk)
check("an unrecognised value fails open", junk.message.model.modelID === SENTINEL.modelID, junk.message.model.modelID)

// ===================== 8. an inferred floor is not a user instruction
// `remember(sessionID, tierRoute(tier))` runs after every successful classification, so from
// turn 2 of any session `route.floor` exists even though the user never typed an override. The
// failure path checks `route?.floor` and cannot tell that floor apart from an explicit >>tier,
// so it holds the last classified tier instead of failing open. When that tier is below the
// user's own model the outage downgrades them — the exact case "default" exists to prevent.
console.log("\n— a floor the classifier inferred is not an instruction —")
writeConfig()
hooks = await ModelRouter({ client: makeClient() } as any)

script = [{ status: 200, tier: "light" }]
const warm = turn(PROMPT_B)
await hooks["chat.message"]({ sessionID: "ses_inferred", agent: "build" }, warm)
check("a light turn routes light (no override typed)", warm.message.model.modelID === expected("light"), warm.message.model.modelID)

toasts = []
script = [{ status: 401 }, { status: 401 }]
const outage = turn(PROMPT_A)
await hooks["chat.message"]({ sessionID: "ses_inferred", agent: "build" }, outage)
check("reports the outage", errorToasts().length === 1, JSON.stringify(toasts))
check(
  "falls back to the user's model, not the last inferred tier",
  outage.message.model.modelID === SENTINEL.modelID,
  `${outage.message.model.modelID} — held the inferred "light" floor instead of failing open`,
)

// ===================== 9. override commands are hidden from the model
// The hook sets TextPart.ignored = true on any part that starts with a prefix. The OpenCode
// message assembler skips parts where ignored === true, so the model never sees ">>off" or
// ">>heavy" as text.
console.log("\n— override commands are hidden from the model —")
writeConfig()
hooks = await ModelRouter({ client: makeClient() } as any)

const overrideParts = [
  { type: "text", text: ">>off" },
  { type: "text", text: ">>heavy plan the migration" },
  { type: "text", text: ">>haiku keep going" },
  { type: "text", text: "just a normal prompt" },
  { type: "text", text: "  >>heavy leading whitespace" },
]
for (const p of overrideParts) {
  script = [{ status: 200, tier: "standard" }]
  const t = { message: { model: { ...SENTINEL } }, parts: [p] }
  await hooks["chat.message"]({ sessionID: "ses_suppress_" + p.text.slice(0, 8), agent: "build" }, t)
}

check(">>off is marked ignored", (overrideParts[0] as any).ignored === true, String((overrideParts[0] as any).ignored))
check(">>heavy prompt is marked ignored", (overrideParts[1] as any).ignored === true, String((overrideParts[1] as any).ignored))
check(">>model pin is marked ignored", (overrideParts[2] as any).ignored === true, String((overrideParts[2] as any).ignored))
check("plain prompt is NOT marked ignored", (overrideParts[3] as any).ignored !== true, String((overrideParts[3] as any).ignored))
check("leading-whitespace override is marked ignored", (overrideParts[4] as any).ignored === true, String((overrideParts[4] as any).ignored))

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
