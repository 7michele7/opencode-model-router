import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  buildCatalog,
  CLASSIFIER_SYSTEM,
  DEFAULTS,
  parseTier,
  resolveTier,
  shouldSkip,
  TIERS,
  type CatalogEntry,
  type RouterConfig,
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
      model: cfg.classifier,
      max_tokens: 60,
      temperature: 0,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user", content: prompt.slice(0, 4000) },
      ],
    }),
  })
  if (!res.ok) return undefined

  const body: any = await res.json()
  return parseTier(body?.choices?.[0]?.message?.content ?? "")
}

export const ModelRouter: Plugin = async ({ client }) => {
  const cfg = loadConfig()
  const auth = gatewayToken()

  let catalog: CatalogEntry[] = []
  let catalogAt = 0
  const decisions = new Map<string, Tier>()

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
    // Must be set here, not in chat.params: the assistant turn re-reads its model from the
    // *persisted* user message, and this hook fires immediately before that write.
    "chat.message": async (input, output) => {
      try {
        if (!cfg.enabled || !auth) return
        if (input.agent && cfg.skipAgents.includes(input.agent)) return

        const target = output.message?.model
        if (!target) return

        const prompt = (output.parts ?? [])
          .filter((p: any) => p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n")
          .trim()

        const override = prompt.match(/^!(\S+)/)?.[1]?.toLowerCase()
        if (!override && shouldSkip(prompt, cfg)) return

        const models = await catalogue()
        if (!models.length) return

        const apply = (entry: CatalogEntry, label: string) => {
          target.providerID = entry.providerID
          target.modelID = entry.modelID
          delete (target as any).variant
          notify(`→ ${entry.modelID}  ·  ${label}`)
        }

        if (override) {
          if (override === "off") return
          if (TIERS.includes(override as Tier)) {
            const entry = resolveTier(override as Tier, models, cfg)
            if (entry) apply(entry, `${override} (forced)`)
            return
          }
          const entry = models.find((m) => m.id.toLowerCase().includes(override))
          if (entry) apply(entry, "forced")
          else notify(`no model matches "!${override}"`, "warning")
          return
        }

        const endpoint = await compatEndpoint(auth.host, auth.token)
        if (!endpoint) return

        const cached = decisions.get(prompt)
        const decision = cached ? { tier: cached, why: "cached" } : await classify(prompt, cfg, endpoint, auth.token)
        if (!decision) return

        if (decisions.size > 200) decisions.clear()
        decisions.set(prompt, decision.tier)

        const entry = resolveTier(decision.tier, models, cfg)
        if (entry) apply(entry, `${decision.tier} · ${decision.why}`)
      } catch {}
    },
  }
}
