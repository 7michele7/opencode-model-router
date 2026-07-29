import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  autoTiers,
  buildCatalog,
  frontierOf,
  resolveTier,
  shouldSkip,
  parseTier,
  parseOverride,
  clampTier,
  tierRank,
  TIERS,
  DEFAULTS,
  type RouterConfig,
  type Tier,
} from "../src/model-router/core.ts"

const here = dirname(fileURLToPath(import.meta.url))
const providers = JSON.parse(readFileSync(join(here, "fixtures/providers.json"), "utf8")).providers

const cfg = (o: Partial<RouterConfig> = {}): RouterConfig => ({ ...DEFAULTS, ...o })

let passed = 0
let failed = 0
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++
  else failed++
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${!cond && detail ? `  -> got ${detail}` : ""}`)
}

const catalog = buildCatalog(providers, cfg())
console.log(`\ncatalog: ${catalog.length} routable  |  frontier: ${frontierOf(catalog).length}\n`)

console.log("— catalog filters —")
check("drops image-output models", !catalog.some((m) => /image/.test(m.modelID)))
check("drops audio-output models", !catalog.some((m) => /realtime|live/.test(m.modelID)))
check("drops non-toolcall models", !catalog.some((m) => /embedding/.test(m.modelID)))
check("drops denied families", !catalog.some((m) => /robotics|deep-research/.test(m.modelID)))
check(
  "dedupes dated aliases",
  !catalog.some((m) => /-\d{8}$/.test(m.modelID) && catalog.some((o) => o.modelID === m.modelID.replace(/-\d{8}$/, ""))),
)
check("sorted by output cost", catalog.every((m, i) => i === 0 || catalog[i - 1].outputCost <= m.outputCost))

console.log("\n— tier resolution honours preferences —")
const heavy = resolveTier("heavy", catalog, cfg())
const standard = resolveTier("standard", catalog, cfg())
const light = resolveTier("light", catalog, cfg())
check("heavy -> claude-opus-5", heavy?.id === "anthropic/claude-opus-5", heavy?.id)
check("standard -> claude-sonnet-4-6", standard?.id === "anthropic/claude-sonnet-4-6", standard?.id)
check("light -> gpt-4o-mini or haiku", light?.id === "openai/gpt-4o-mini" || light?.id === "anthropic/claude-haiku-4-5", light?.id)

console.log("\n— self-healing when a preferred model disappears —")
const orphaned = cfg({ tiers: { ...DEFAULTS.tiers, heavy: ["anthropic/claude-opus-does-not-exist"] } })
const healed = resolveTier("heavy", catalog, orphaned)
check("falls back to a live model", !!healed && healed.id !== "anthropic/claude-opus-does-not-exist", healed?.id)
check("fallback is the priciest frontier model", healed?.outputCost === frontierOf(catalog).at(-1)?.outputCost)
console.log(`        picked: ${healed?.id}`)

console.log("\n— allow / deny —")
const allowIds = ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-5", "anthropic/claude-opus-5"]
const allowCfg = cfg({ allow: allowIds })
const restricted = buildCatalog(providers, allowCfg)
check("allowlist restricts catalog", restricted.length === 3, String(restricted.length))
check("allowlist heavy -> opus-5", resolveTier("heavy", restricted, allowCfg)?.modelID === "claude-opus-5")
check(
  "allowlist standard falls through to sonnet-5",
  resolveTier("standard", restricted, allowCfg)?.modelID === "claude-sonnet-5",
  resolveTier("standard", restricted, allowCfg)?.modelID,
)
check("allowlist light falls through to haiku", resolveTier("light", restricted, allowCfg)?.modelID === "claude-haiku-4-5")

const globbed = buildCatalog(providers, cfg({ allow: ["anthropic/*"] }))
check("glob allowlist keeps one provider", globbed.length > 0 && globbed.every((m) => m.providerID === "anthropic"))
check("deny glob removes matches", !buildCatalog(providers, cfg({ deny: ["*opus*"] })).some((m) => /opus/.test(m.modelID)))
check("empty allow keeps everything", buildCatalog(providers, cfg({ allow: [] })).length === catalog.length)

console.log("\n— skip fast-path —")
for (const word of ["yes", "ok", "continue", "go on", "thanks"]) {
  check(`skips "${word}"`, shouldSkip(word, cfg()))
}
check("skips short prompts", shouldSkip("fix it", cfg()))
check("routes real prompts", !shouldSkip("refactor the routing layer to react router v7", cfg()))

console.log("\n— override prefixes —")
const P = DEFAULTS.prefixes
check("\">>heavy\" -> heavy", parseOverride(">>heavy do the thing", P) === "heavy", parseOverride(">>heavy x", P))
check("\">>off\" -> off", parseOverride(">>off x", P) === "off")
check("\">>opus\" -> opus", parseOverride(">>opus x", P) === "opus")
check("\"!heavy\" still works for HTTP clients", parseOverride("!heavy x", P) === "heavy")
check("uppercase is lowercased", parseOverride(">>HEAVY x", P) === "heavy")
check("prefix with no args", parseOverride(">>heavy", P) === "heavy")
check("longer prefix wins", parseOverride(">>heavy x", [">", ">>"]) === "heavy")
check("plain prompt is not an override", parseOverride("refactor the routing layer", P) === undefined)
check("bare prefix is not an override", parseOverride(">> ", P) === undefined)
check("mid-prompt prefix ignored", parseOverride("compare a >>heavy thing", P) === undefined)
check("@file is not an override", parseOverride("@utils.ts explain", P) === undefined)
check("/command is not an override", parseOverride("/review-mr 123", P) === undefined)

console.log("\n— classifier parsing —")
check("parses bare json", parseTier('{"tier":"light","why":"rename"}')?.tier === "light")
check("parses fenced json", parseTier('```json\n{"tier":"heavy","why":"migration"}\n```')?.tier === "heavy")
check("parses json with prose around it", parseTier('Sure! {"tier":"standard","why":"x"} done')?.tier === "standard")
check("rejects unknown tier", parseTier('{"tier":"nuclear"}') === undefined)
check("rejects non-json", parseTier("I think this is heavy") === undefined)
check("rejects malformed json", parseTier('{"tier":') === undefined)

console.log("\n— auto-discovery —")
const auto = autoTiers(catalog)
check("auto-discovery returns all three tiers", Object.keys(auto).length === 3)
check("auto-discovery light is cheapest", auto.light.every((id) => {
  const e = catalog.find((m) => m.id === id)
  return e && e.outputCost < 1
}))
check("auto-discovery standard is mid-cost", auto.standard.every((id) => {
  const e = catalog.find((m) => m.id === id)
  return e && e.outputCost >= 1 && e.outputCost < 6
}))
check("auto-discovery heavy is priciest", auto.heavy.every((id) => {
  const e = catalog.find((m) => m.id === id)
  return e && e.outputCost >= 6
}))
check("auto-discovery respects maxPerTier", auto.light.length <= 3 && auto.standard.length <= 3 && auto.heavy.length <= 3)

const autoCfg = cfg({ autoDiscovery: true })
const autoHeavy = resolveTier("heavy", catalog, autoCfg)
check("resolveTier honours auto-discovery", auto.heavy.includes(autoHeavy?.id ?? ""), autoHeavy?.id)

console.log("\n— tier ranking —")
check("TIERS order is the rank contract", TIERS.join() === "light,standard,heavy", TIERS.join())
check("light < standard < heavy", tierRank("light") < tierRank("standard") && tierRank("standard") < tierRank("heavy"))

console.log("\n— clampTier: classifier may only ratchet up —")
check("no floor passes tier through", clampTier("light", undefined) === "light")
check("raises light to heavy floor", clampTier("light", "heavy") === "heavy")
check("raises light to standard floor", clampTier("light", "standard") === "standard")
check("raises standard to heavy floor", clampTier("standard", "heavy") === "heavy")
check("never lowers heavy to light floor", clampTier("heavy", "light") === "heavy")
check("never lowers standard to light floor", clampTier("standard", "light") === "standard")
check("equal floor is a no-op", TIERS.every((t) => clampTier(t, t) === t))
check(
  "monotonic: result >= both inputs for all 9 pairs",
  TIERS.every((a) => TIERS.every((b) => {
    const r = clampTier(a, b)
    return tierRank(r) >= tierRank(a) && tierRank(r) >= tierRank(b)
  })),
)

console.log("\n— session floor behaviour —")
const floors = new Map<string, Tier>()

floors.set("ses_pin", "heavy")
check("pinned heavy survives a light classification", clampTier("light", floors.get("ses_pin")) === "heavy")
check("without a floor the downgrade reproduces", clampTier("light", floors.get("ses_none")) === "light")

const esc = "ses_escalate"
for (const c of ["light", "standard", "heavy", "light"] as Tier[]) floors.set(esc, clampTier(c, floors.get(esc)))
check("classifier ratchets up and holds", floors.get(esc) === "heavy", floors.get(esc))

floors.set("ses_off", "heavy")
floors.delete("ses_off")
check(">>off clears the floor", clampTier("light", floors.get("ses_off")) === "light")

floors.set("ses_down", "heavy")
floors.set("ses_down", "light")
check(">>light lowers the floor (explicit intent wins)", clampTier("light", floors.get("ses_down")) === "light")

check("floors are per-session, not global", clampTier("light", floors.get("ses_pin")) === "heavy" && clampTier("light", floors.get("ses_other")) === "light")

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
