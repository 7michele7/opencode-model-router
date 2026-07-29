export type Tier = "light" | "standard" | "heavy"

export type RouterConfig = {
  enabled: boolean
  classifier: string | string[]
  classifierTimeoutMs: number
  toast: boolean
  toastDurationMs: number
  minPromptChars: number
  skipAgents: string[]
  skipCommands: boolean
  prefixes: string[]
  allow: string[]
  deny: string[]
  autoDiscovery?: boolean
  maxModelsPerTier?: number
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

export const tierRank = (tier: Tier) => TIERS.indexOf(tier)

// Classifier decisions may only ratchet up. Explicit user overrides set the floor directly.
export const clampTier = (tier: Tier, floor: Tier | undefined): Tier =>
  floor && tierRank(floor) > tierRank(tier) ? floor : tier

// A session is either following a tier floor or held on one exact model, never both.
export type SessionRoute = { floor: Tier; pin?: undefined } | { pin: string; floor?: undefined }

export const tierRoute = (floor: Tier): SessionRoute => ({ floor })
export const pinRoute = (pin: string): SessionRoute => ({ pin })

export const resolvePin = (route: SessionRoute | undefined, catalog: CatalogEntry[]) =>
  route?.pin ? catalog.find((m) => m.id === route.pin) : undefined

export const DEFAULTS: RouterConfig = {
  enabled: true,
  classifier: ["google-ai-studio/gemini-3.5-flash-lite", "google-ai-studio/gemini-2.5-flash-lite"],
  classifierTimeoutMs: 5000,
  toast: true,
  toastDurationMs: 6000,
  minPromptChars: 12,
  skipAgents: [],
  skipCommands: true,
  prefixes: [">>"],
  allow: [],
  // Taste, not data: these are text+tool-capable but not coding models.
  deny: ["*robotics*", "*deep-research*"],
  autoDiscovery: false,
  maxModelsPerTier: 3,
  tiers: {
    light: ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5"],
    standard: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-5"],
    heavy: ["anthropic/claude-opus-5", "anthropic/claude-opus-4-6"],
  },
}

export const CLASSIFIER_SYSTEM = `Classify a coding request into ONE tier. The user is a principal engineer working in a large TypeScript/React monorepo.

light    - self-contained and mechanical. Answerable from general knowledge, or one obvious edit. (rename, typo, version bump, formatting, "what does useMemo do", "what is the syntax for X")
standard - normal feature work in one area, OR any request that must read the project or the conversation before it can be answered, OR anything that rewrites an existing file. (add a component, write a test, fix a described bug, "what did we do so far", "update the README", "did you push")
heavy    - needs real reasoning: architecture, cross-cutting refactor, migration, subtle or unknown bug, security review, tradeoff analysis, or touches many files.

Rules:
- A short prompt is NOT automatically light. Judge the work required, not the wording.
- A question is only light if you could answer it without reading any file, the repo, or the earlier conversation.
- Rewriting or deleting an existing file is never light.
- If unsure between two tiers, pick the HIGHER one.

Reply ONLY: {"tier":"light|standard|heavy","why":"max 4 words"}`

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

export const autoTiers = (catalog: CatalogEntry[], maxPerTier = 3): Record<Tier, string[]> => {
  const frontier = frontierOf(catalog)

  const light = frontier
    .filter((e) => costBand(e.outputCost) === 0)
    .sort((a, b) => a.outputCost - b.outputCost)
    .slice(0, maxPerTier)
    .map((e) => e.id)

  const standard = frontier
    .filter((e) => costBand(e.outputCost) === 1)
    .sort((a, b) => b.outputCost - a.outputCost)
    .slice(0, maxPerTier)
    .map((e) => e.id)

  const heavy = frontier
    .filter((e) => costBand(e.outputCost) >= 2)
    .sort((a, b) => b.outputCost - a.outputCost)
    .slice(0, maxPerTier)
    .map((e) => e.id)

  return { light, standard, heavy }
}

export const resolveTier = (tier: Tier, catalog: CatalogEntry[], cfg: RouterConfig) => {
  const preferred = cfg.autoDiscovery
    ? autoTiers(catalog, cfg.maxModelsPerTier)[tier]
    : (cfg.tiers[tier] ?? [])

  for (const id of preferred) {
    const hit = catalog.find((e) => e.id === id)
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

// "@" and "/" are not usable as prefixes, the TUI binds them to autocomplete.
export const parseOverride = (prompt: string, prefixes: string[]): string | undefined => {
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (!prefix || !prompt.startsWith(prefix)) continue
    const token = prompt.slice(prefix.length).match(/^(\S+)/)?.[1]
    if (token) return token.toLowerCase()
  }
  return undefined
}

export const shouldSkip = (prompt: string, cfg: RouterConfig) =>
  !prompt || prompt.length < cfg.minPromptChars || CONTINUATION.test(prompt)
