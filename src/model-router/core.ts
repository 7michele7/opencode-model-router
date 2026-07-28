export type Tier = "light" | "standard" | "heavy"

export type RouterConfig = {
  enabled: boolean
  classifier: string
  classifierTimeoutMs: number
  toast: boolean
  minPromptChars: number
  skipAgents: string[]
  allow: string[]
  deny: string[]
  tiers: Record<Tier, string[]>
}

export type CatalogEntry = {
  id: string
  providerID: string
  modelID: string
  outputCost: number
  context: number
  releaseDate: string
}

export const TIERS: Tier[] = ["light", "standard", "heavy"]

export const DEFAULTS: RouterConfig = {
  enabled: true,
  classifier: "google-ai-studio/gemini-3.5-flash-lite",
  classifierTimeoutMs: 5000,
  toast: true,
  minPromptChars: 12,
  skipAgents: [],
  allow: [],
  // Taste, not data: these are text+tool-capable but not coding models.
  deny: ["*robotics*", "*deep-research*"],
  tiers: {
    light: [
      "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
      "anthropic/claude-haiku-4-5",
    ],
    standard: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-5"],
    heavy: ["anthropic/claude-opus-5", "anthropic/claude-opus-4-6"],
  },
}

export const CLASSIFIER_SYSTEM = `Classify a coding request into ONE tier. The user is a principal engineer working in a large TypeScript/React monorepo.

light    - mechanical, single obvious edit, or a plain question. No design judgement needed. (rename, typo, version bump, formatting, "what does X do")
standard - normal feature work in one area. Clear requirements, real code to write. (add a component, write a test, fix a described bug, add a story)
heavy    - needs real reasoning: architecture, cross-cutting refactor, migration, subtle or unknown bug, security review, tradeoff analysis, or touches many files.

If unsure between two tiers, pick the HIGHER one. Reply ONLY: {"tier":"light|standard|heavy","why":"max 4 words"}`

export const CONTINUATION =
  /^(y|yes|yep|yeah|ok|okay|k|go|go on|continue|proceed|do it|next|sure|please|thanks|ty|no|nope|stop|wait|hold on|nvm)[\s.!?]*$/i

export const toRegExp = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i")

export const matchesAny = (id: string, patterns: string[]) =>
  patterns.some((pattern) => {
    try {
      return toRegExp(pattern).test(id)
    } catch {
      return false
    }
  })

export const isRoutable = (model: any) => {
  const caps = model?.capabilities
  if (!(caps?.toolcall ?? model?.tool_call)) return false

  const outputs = caps?.output ?? {}
  const modalities: string[] = model?.modalities?.output ?? []
  const textOut = outputs.text ?? modalities.includes("text")
  const nonTextOut = ["audio", "image", "video"].some(
    (kind) => outputs[kind] ?? modalities.includes(kind),
  )

  if (!textOut || nonTextOut) return false
  if (model?.status === "deprecated") return false
  return true
}

export const buildCatalog = (providers: any[], cfg: RouterConfig): CatalogEntry[] => {
  let entries: CatalogEntry[] = []

  for (const provider of providers ?? []) {
    for (const [modelID, model] of Object.entries<any>(provider?.models ?? {})) {
      if (!isRoutable(model)) continue
      const outputCost = model?.cost?.output
      if (typeof outputCost !== "number" || outputCost <= 0) continue
      entries.push({
        id: `${provider.id}/${modelID}`,
        providerID: provider.id,
        modelID,
        outputCost,
        context: model?.limit?.context ?? 0,
        releaseDate: model?.release_date ?? "",
      })
    }
  }

  if (cfg.deny.length)
    entries = entries.filter((e) => !matchesAny(e.id, cfg.deny) && !matchesAny(e.modelID, cfg.deny))
  if (cfg.allow.length)
    entries = entries.filter((e) => matchesAny(e.id, cfg.allow) || matchesAny(e.modelID, cfg.allow))

  const bases = new Set(entries.map((e) => e.modelID))
  entries = entries.filter((e) => {
    const undated = e.modelID.match(/^(.*)-\d{8}$/)?.[1]
    return !undated || !bases.has(undated)
  })

  return entries.sort((a, b) => a.outputCost - b.outputCost)
}

const costBand = (cost: number) => (cost < 1 ? 0 : cost < 6 ? 1 : cost < 16 ? 2 : 3)

export const frontierOf = (catalog: CatalogEntry[]) => {
  const newest = catalog.map((e) => e.releaseDate).filter(Boolean).sort().pop()
  const cutoff = newest ? Date.parse(newest) - 430 * 864e5 : 0
  const best = new Map<string, CatalogEntry>()

  for (const entry of catalog) {
    if (entry.releaseDate && Date.parse(entry.releaseDate) < cutoff) continue
    const key = `${entry.providerID}:${costBand(entry.outputCost)}`
    const held = best.get(key)
    if (!held || entry.releaseDate > held.releaseDate) best.set(key, entry)
  }

  return [...best.values()].sort((a, b) => a.outputCost - b.outputCost)
}

export const fallbackFor = (tier: Tier, frontier: CatalogEntry[]) => {
  if (!frontier.length) return undefined
  if (tier === "light") return frontier[0]
  if (tier === "heavy") return frontier[frontier.length - 1]
  return frontier[Math.floor((frontier.length - 1) / 2)]
}

export const resolveTier = (tier: Tier, catalog: CatalogEntry[], cfg: RouterConfig) => {
  for (const preferred of cfg.tiers[tier] ?? []) {
    const hit = catalog.find((e) => e.id === preferred)
    if (hit) return hit
  }
  return fallbackFor(tier, frontierOf(catalog))
}

export const parseTier = (raw: string): { tier: Tier; why: string } | undefined => {
  const json = raw.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json)
    if (!TIERS.includes(parsed?.tier)) return undefined
    return { tier: parsed.tier as Tier, why: String(parsed.why ?? "") }
  } catch {
    return undefined
  }
}

export const shouldSkip = (prompt: string, cfg: RouterConfig) =>
  !prompt || prompt.length < cfg.minPromptChars || CONTINUATION.test(prompt)
