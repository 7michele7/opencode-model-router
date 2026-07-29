import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  buildCatalog,
  clampTier,
  CLASSIFIER_SYSTEM,
  DEFAULTS,
  parseOverride,
  parseTier,
  pinRoute,
  resolvePin,
  resolveTier,
  shouldSkip,
  tierRoute,
  TIERS,
  type CatalogEntry,
  type RouterConfig,
  type SessionRoute,
  type Tier,
} from "./model-router/core.ts"

const HOME = homedir()
const CONFIG_FILE = join(HOME, ".config", "opencode", "model-router.json")
const AUTH_FILE = join(HOME, ".local", "share", "opencode", "auth.json")
const GATEWAY_CACHE = join(HOME, ".cache", "opencode", "model-router-gateway.json")

const readJson = <T>(path: string): T | undefined => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined
  } catch {
    return undefined
  }
}

const writeJson = (path: string, value: unknown) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2))
  } catch {}
}

const loadConfig = (): RouterConfig => {
  const stored = readJson<Partial<RouterConfig>>(CONFIG_FILE)
  if (!stored) {
    writeJson(CONFIG_FILE, DEFAULTS)
    return DEFAULTS
  }
  return { ...DEFAULTS, ...stored, tiers: { ...DEFAULTS.tiers, ...(stored.tiers ?? {}) } }
}

const gatewayToken = () => {
  const auth = readJson<Record<string, any>>(AUTH_FILE) ?? {}
  for (const [host, value] of Object.entries(auth)) {
    if (value?.type === "wellknown" && value?.token) return { host, token: value.token as string }
  }
  return undefined
}

const compatEndpoint = async (host: string, token: string) => {
  const cached = readJson<{ url: string; at: number }>(GATEWAY_CACHE)
  if (cached?.url && Date.now() - cached.at < 864e5) return cached.url

  const res = await fetch(`${host}/config/opencode.json`, {
    headers: { "cf-access-token": token, "User-Agent": "opencode-model-router" },
  })
  if (!res.ok) return undefined

  const remote: any = await res.json()
  const baseURLs = Object.values<any>(remote?.provider ?? {})
    .map((p) => p?.options?.baseURL)
    .filter((u): u is string => typeof u === "string")

  const compat =
    baseURLs.find((u) => u.endsWith("/compat")) ?? baseURLs[0]?.replace(/\/[^/]+(\/v1beta)?$/, "/compat")
  if (!compat) return undefined

  writeJson(GATEWAY_CACHE, { url: compat, at: Date.now() })
  return compat
}

const classify = async (prompt: string, cfg: RouterConfig, endpoint: string, token: string) => {
  const models = Array.isArray(cfg.classifier) ? cfg.classifier : [cfg.classifier]
  const errors: string[] = []

  for (const model of models) {
    try {
      const res = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(cfg.classifierTimeoutMs),
        headers: {
          "cf-access-token": token,
          "X-Requested-With": "xmlhttprequest",
          "content-type": "application/json",
          "User-Agent": "opencode-model-router",
        },
        body: JSON.stringify({
          model,
          max_tokens: 60,
          temperature: 0,
          messages: [
            { role: "system", content: CLASSIFIER_SYSTEM },
            { role: "user", content: prompt.slice(0, 4000) },
          ],
        }),
      })
      if (!res.ok) {
        errors.push(`${model}: HTTP ${res.status}`)
        continue
      }
      const body: any = await res.json()
      const parsed = parseTier(body?.choices?.[0]?.message?.content ?? "")
      if (parsed) return parsed
      errors.push(`${model}: invalid response`)
    } catch (err: any) {
      errors.push(`${model}: ${err?.name ?? "error"}`)
    }
  }

  return { tier: undefined as undefined, errors }
}

export const ModelRouter: Plugin = async ({ client }) => {
  const cfg = loadConfig()
  const auth = gatewayToken()

  let catalog: CatalogEntry[] = []
  let catalogAt = 0
  const decisions = new Map<string, Tier>()
  const routes = new Map<string, SessionRoute>()

  const remember = (sessionID: string, route: SessionRoute) => {
    if (routes.size > 500) routes.clear()
    routes.set(sessionID, route)
  }

  const pendingCommand = new Set<string>()
  const commandSessions = new Map<string, number>()
  const parents = new Map<string, string | undefined>()
  const commandChildren = new Set<string>()
  let pinnedAgents: Set<string> | undefined

  const COMMAND_TTL = 30_000

  const ranCommand = (sessionID: string) => {
    const expiry = commandSessions.get(sessionID)
    return expiry !== undefined && expiry > Date.now()
  }

  const parentOf = async (sessionID: string) => {
    if (parents.has(sessionID)) return parents.get(sessionID)
    let parentID: string | undefined
    try {
      const res: any = await client.session.get({ path: { id: sessionID } })
      parentID = (res?.data ?? res)?.parentID
    } catch {}
    if (parents.size > 500) parents.clear()
    parents.set(sessionID, parentID)
    return parentID
  }

  const agentPinsModel = async (agent: string) => {
    if (!pinnedAgents) {
      try {
        const res: any = await client.app.agents()
        pinnedAgents = new Set(
          ((res?.data ?? res) as any[]).filter((a) => a?.model).map((a) => a.name),
        )
      } catch {
        pinnedAgents = new Set()
      }
    }
    return pinnedAgents.has(agent)
  }

  // pendingCommand is consumed by the command's own turn, so later prompts typed into that
  // same session still get routed. commandSessions only exists to link subtask children.
  const isCommandDriven = async (sessionID: string) => {
    if (pendingCommand.delete(sessionID)) return true
    if (commandChildren.has(sessionID)) return true

    const parentID = await parentOf(sessionID)
    if (!parentID || !ranCommand(parentID)) return false

    if (commandChildren.size > 500) commandChildren.clear()
    commandChildren.add(sessionID)
    return true
  }

  const catalogue = async () => {
    if (catalog.length && Date.now() - catalogAt < 3e5) return catalog
    const res: any = await client.config.providers()
    catalog = buildCatalog(res?.data?.providers ?? res?.providers ?? [], cfg)
    catalogAt = Date.now()
    return catalog
  }

  const notify = (message: string, variant: "info" | "warning" = "info") => {
    if (!cfg.toast) return
    client.tui.showToast({ body: { message, variant, duration: cfg.toastDurationMs } }).catch(() => {})
  }

  return {
    "command.execute.before": async (input) => {
      if (!cfg.skipCommands || !input.sessionID) return
      pendingCommand.add(input.sessionID)
      commandSessions.set(input.sessionID, Date.now() + COMMAND_TTL)
      for (const [id, expiry] of commandSessions) if (expiry < Date.now()) commandSessions.delete(id)
    },

    // Must be set here, not in chat.params: the assistant turn re-reads its model from the
    // *persisted* user message, and this hook fires immediately before that write.
    "chat.message": async (input, output) => {
      try {
        if (!cfg.enabled || !auth) return
        if (input.agent && cfg.skipAgents.includes(input.agent)) return
        if (input.agent && (await agentPinsModel(input.agent))) return
        if (cfg.skipCommands && (await isCommandDriven(input.sessionID))) return

        const target = output.message?.model
        if (!target) return

        const prompt = (output.parts ?? [])
          .filter((p: any) => p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n")
          .trim()

        const override = parseOverride(prompt, cfg.prefixes)
        const unclassifiable = !override && shouldSkip(prompt, cfg)

        const models = await catalogue()
        if (!models.length) return

        const apply = (entry: CatalogEntry, label: string) => {
          target.providerID = entry.providerID
          target.modelID = entry.modelID
          delete (target as any).variant
          notify(`→ ${entry.modelID}  ·  ${label}`)
        }

        const route = routes.get(input.sessionID)

        // An exact model pin wins over everything and needs no classification.
        const pinned = resolvePin(route, models)
        if (pinned && !override) {
          apply(pinned, "pinned")
          return
        }
        if (route?.pin && !pinned) routes.delete(input.sessionID)

        // A session with a tier floor keeps it even for prompts we never send to the classifier.
        if (unclassifiable) {
          if (!route?.floor) return
          const entry = resolveTier(route.floor, models, cfg)
          if (entry) apply(entry, `${route.floor} (held)`)
          return
        }

        if (override) {
          if (override === "off") {
            routes.delete(input.sessionID)
            return
          }
          if (TIERS.includes(override as Tier)) {
            const tier = override as Tier
            remember(input.sessionID, tierRoute(tier))
            const entry = resolveTier(tier, models, cfg)
            if (entry) apply(entry, `${tier} (pinned)`)
            return
          }
          const entry = models.find((m) => m.id.toLowerCase().includes(override))
          if (entry) {
            remember(input.sessionID, pinRoute(entry.id))
            apply(entry, "pinned")
          } else notify(`no model matches "${override}"`, "warning")
          return
        }

        const endpoint = await compatEndpoint(auth.host, auth.token)
        if (!endpoint) return

        const cacheKey = `${input.sessionID}:${prompt}`
        const cached = decisions.get(cacheKey)
        let decision = cached ? { tier: cached, why: "cached" } : undefined
        let fallback = false

        if (!decision) {
          const result = await classify(prompt, cfg, endpoint, auth.token)
          if (result && "tier" in result && result.tier) {
            decision = result
          } else {
            fallback = true
            decision = { tier: "standard" as Tier, why: "classifier failed" }
            notify(`classifier failed · falling back to standard`, "warning")
          }
        }

        if (!decision) return

        if (decisions.size > 200) decisions.clear()
        decisions.set(cacheKey, decision.tier)

        const tier = clampTier(decision.tier, route?.floor)
        remember(input.sessionID, tierRoute(tier))

        const entry = resolveTier(tier, models, cfg)
        if (!entry) return
        apply(
          entry,
          tier === decision.tier
            ? `${tier} · ${decision.why}${fallback ? " (fallback)" : ""}`
            : `${tier} · held (classified ${decision.tier})`,
        )
      } catch {}
    },
  }
}
