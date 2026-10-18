// model-sync —— Pi extension
//
// 一条命令同步**指定** provider 的模型清单，其他 provider 一概不碰。
//
//   /model-sync <provider>              同步该 provider
//   /model-sync <provider> --dry-run    只报告，不写盘
//   /model-sync                         列出可同步的 provider 让你选
//
// 规则（与用户逐条确认过）：
//   1. 拉取范围：只用 GET {baseUrl}/models 的结果当权威清单。
//   2. 删除：现有条目不在该清单里 → 删。清单请求失败或返回空 → 整个同步中止，一条不删。
//   3. 匹配：取模型 id 最后一个斜杠后面的部分（如 kilo/cohere/north-mini-code:free
//      → north-mini-code:free），拿这个键去 models.dev 全局查。多个命名空间都有同名模型时
//      按命名空间字母序取第一个。
//   4. 覆盖：models.dev 命中 → 覆盖 contextWindow / maxTokens / reasoning / input / cost。
//      未命中 → 现有条目原样保留，一个新字段都不动。
//   5. 新增：清单里有、本地没有的模型才新建；查不到 models.dev 就用保守默认值。
//   6. cost：models.dev 没有 cost 字段时保留本地已有的 cost，本地也没有就省略该字段。
//   7. 写盘前备份 models.json.bak-<ISO 时间戳>，写后热加载模型注册表。

import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// getModelsPath() 只在 dist/config 里，包根没导出；models.json 恒在 agent 目录下。
const modelsPath = (): string => path.join(getAgentDir(), "models.json");

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_FILE = "model-sync-modelsdev.json";

const DEFAULTS = {
	contextWindow: 128_000,
	maxTokens: 16_384,
};

type Json = Record<string, any>;

interface ProviderEntry {
	id: string;
	api: string;
	baseUrl: string;
	apiKey?: string;
	authHeader?: boolean;
	compat?: Json;
	headers?: Json;
	models: Json[];
}

/** 匹配键：最后一个斜杠之后的部分；没有斜杠就是整个 id。 */
function matchKey(id: string): string {
	const cut = id.lastIndexOf("/");
	return cut === -1 ? id : id.slice(cut + 1);
}

/** models.dev 全局索引：模型名 → 该名字出现在哪些命名空间（已排序，字母序）。 */
function buildIndex(catalog: Json): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const namespace of Object.keys(catalog).sort()) {
		const models = catalog[namespace]?.models;
		if (!models || typeof models !== "object") continue;
		for (const name of Object.keys(models)) {
			const list = index.get(name);
			if (list) {
				if (!list.includes(namespace)) list.push(namespace);
			} else {
				index.set(name, [namespace]);
			}
		}
	}
	return index;
}

function finite(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
	}
	return undefined;
}

function positive(value: unknown): number | undefined {
	const number = finite(value);
	return number !== undefined && number > 0 ? number : undefined;
}

/** 只保留 pi 认识的输入模态。 */
function inputModalities(entry: Json): string[] | undefined {
	const raw = entry?.modalities?.input;
	if (!Array.isArray(raw)) return undefined;
	const kept = [...new Set(raw.filter((m: unknown) => m === "text" || m === "image"))];
	return kept.length > 0 ? kept : undefined;
}

/** models.dev 条目 → pi 模型字段。缺的字段不返回，交给调用方决定保留还是补默认。 */
function paramsFromModelsDev(entry: Json): Json {
	const out: Json = {};
	const context = positive(entry?.limit?.context);
	if (context !== undefined) out.contextWindow = context;
	const output = positive(entry?.limit?.output);
	if (output !== undefined) out.maxTokens = output;
	if (typeof entry?.reasoning === "boolean") out.reasoning = entry.reasoning;
	const input = inputModalities(entry);
	if (input) out.input = input;

	const cost = entry?.cost;
	if (cost && typeof cost === "object") {
		const pick = (keys: string[]) => {
			for (const key of keys) {
				const value = finite(cost[key]);
				if (value !== undefined) return value;
			}
			return undefined;
		};
		const built: Json = {};
		let known = false;
		for (const [leg, keys] of [
			["input", ["input"]],
			["output", ["output"]],
			["cacheRead", ["cache_read", "cacheRead"]],
			["cacheWrite", ["cache_write", "cacheWrite"]],
		] as const) {
			const value = pick([...keys]);
			if (value !== undefined) known = true;
			built[leg] = value ?? 0;
		}
		if (known) out.cost = built;
	}
	return out;
}

/** 请求头：复用 pi 对该 provider 的鉴权约定（authHeader 表示用 x-api-key 而非 Bearer）。 */
function authHeaders(provider: ProviderEntry): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json" };
	const key = provider.apiKey;
	if (key && key.trim() !== "") {
		if (provider.authHeader) headers["x-api-key"] = key;
		else headers.authorization = `Bearer ${key}`;
	}
	if (provider.headers && typeof provider.headers === "object") {
		for (const [name, value] of Object.entries(provider.headers)) {
			if (typeof value === "string") headers[name.toLowerCase()] = value;
		}
	}
	return headers;
}

async function fetchLiveModels(provider: ProviderEntry, signal: AbortSignal): Promise<string[]> {
	const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
	const response = await fetch(url, { headers: authHeaders(provider), signal });
	if (!response.ok) {
		throw new Error(`GET ${url} → HTTP ${response.status} ${response.statusText}`);
	}
	const payload: any = await response.json();
	const entries = Array.isArray(payload) ? payload : (payload?.data ?? payload?.models ?? []);
	if (!Array.isArray(entries)) throw new Error(`GET ${url} 返回了无法识别的结构`);
	const ids = entries
		.map((entry: any) => (typeof entry === "string" ? entry : entry?.id))
		.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
	if (ids.length === 0) throw new Error(`GET ${url} 返回了空模型列表`);
	return [...new Set(ids)];
}

/** models.dev 目录：优先用 6 小时内的本地缓存，过期才联网。 */
async function loadCatalog(agentDir: string, signal: AbortSignal): Promise<Json> {
	const cachePath = path.join(agentDir, CACHE_FILE);
	try {
		const stat = fs.statSync(cachePath);
		if (Date.now() - stat.mtimeMs < MODELS_DEV_TTL_MS) {
			return JSON.parse(fs.readFileSync(cachePath, "utf8"));
		}
	} catch {
		// 缓存缺失或损坏：走网络
	}
	const response = await fetch(MODELS_DEV_URL, { headers: { accept: "application/json" }, signal });
	if (!response.ok) throw new Error(`models.dev → HTTP ${response.status}`);
	const catalog: Json = await response.json();
	try {
		fs.writeFileSync(cachePath, JSON.stringify(catalog));
	} catch {
		// 缓存写失败不影响本次同步
	}
	return catalog;
}

interface SyncPlan {
	added: string[];
	updated: string[];
	removed: string[];
	kept: string[];
	unmatched: string[];
	missingCost: string[];
	nextModels: Json[];
}

function planSync(provider: ProviderEntry, liveIds: string[], catalog: Json): SyncPlan {
	const index = buildIndex(catalog);
	const live = new Set(liveIds);
	const plan: SyncPlan = {
		added: [],
		updated: [],
		removed: [],
		kept: [],
		unmatched: [],
		missingCost: [],
		nextModels: [],
	};

	const byId = new Map<string, Json>();
	for (const model of provider.models) {
		if (typeof model?.id === "string") byId.set(model.id, model);
	}

	for (const id of liveIds) {
		const existing = byId.get(id);
		const namespaces = index.get(matchKey(id));
		const namespace = namespaces?.[0];
		const entry = namespace ? catalog[namespace]?.models?.[matchKey(id)] : undefined;
		const params = entry ? paramsFromModelsDev(entry) : undefined;

		if (!entry) plan.unmatched.push(id);

		if (existing) {
			// 命中 models.dev：覆盖已知字段，未覆盖的字段保持原样。
			// 未命中：原样保留，一个新字段都不动。
			const merged: Json = { ...existing, ...(params ?? {}) };
			if (params?.cost === undefined && existing.cost === undefined) plan.missingCost.push(id);
			plan.nextModels.push(merged);
			if (params) plan.updated.push(id);
			else plan.kept.push(id);
			continue;
		}
		// 本地没有这个模型：新建。查得到就用真值，查不到用保守默认值。
		const base: Json = {
			id,
			name: id,
			reasoning: params?.reasoning ?? false,
			input: params?.input ?? ["text"],
			contextWindow: params?.contextWindow ?? DEFAULTS.contextWindow,
			maxTokens: params?.maxTokens ?? DEFAULTS.maxTokens,
		};
		if (params?.cost) base.cost = params.cost;
		plan.added.push(id);
		plan.nextModels.push(base);
	}

	for (const id of byId.keys()) {
		if (!live.has(id)) plan.removed.push(id);
	}

	return plan;
}

function formatReport(providerId: string, plan: SyncPlan, liveCount: number): string {
	const lines = [
		`model-sync ${providerId}: live ${liveCount} 个`,
		`  +${plan.added.length} 新增  ~${plan.updated.length} 更新  -${plan.removed.length} 删除  =${plan.kept.length} 保留`,
	];
	if (plan.added.length > 0) lines.push(`  新增: ${plan.added.join(", ")}`);
	if (plan.removed.length > 0) lines.push(`  删除: ${plan.removed.join(", ")}`);
	if (plan.unmatched.length > 0) {
		lines.push(`  models.dev 未匹配 ${plan.unmatched.length} 个（保留原值）: ${plan.unmatched.join(", ")}`);
	}
	if (plan.missingCost.length > 0) {
		const only = plan.missingCost.filter((id) => !plan.unmatched.includes(id));
		if (only.length > 0) lines.push(`  无价格数据 ${only.length} 个: ${only.join(", ")}`);
	}
	return lines.join("\n");
}

function timestamp(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** fetch 的失败原因藏在 cause 里，只报 "fetch failed" 对排查没任何帮助。 */
function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as { cause?: unknown }).cause;
	if (cause instanceof Error) {
		const code = (cause as { code?: string }).code;
		return `${error.message} (${cause.message}${code ? `, ${code}` : ""})`;
	}
	return error.message;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("model-sync", {
		description: "同步指定 provider 的模型清单：/model-sync <provider> [--dry-run]",
		handler: async (rawArgs, ctx) => {
			const args = (Array.isArray(rawArgs) ? rawArgs.join(" ") : (rawArgs ?? "")).trim();
			const tokens = args.split(/\s+/).filter((token) => token !== "");
			const dryRun = tokens.includes("--dry-run");
			let providerId = tokens.find((token) => !token.startsWith("--"));

			if (tokens.some((token) => token.startsWith("--") && token !== "--dry-run")) {
				ctx.ui.notify("用法: /model-sync <provider> [--dry-run]", "warning");
				return;
			}

			const filePath = modelsPath();
			const agentDir = getAgentDir();
			const readFile = (): Json => JSON.parse(fs.readFileSync(filePath, "utf8"));
			const file = readFile();
			const providers: Json = file.providers ?? {};

			if (!providerId) {
				const candidates = Object.entries(providers)
					.filter(([, value]: [string, any]) => typeof value?.baseUrl === "string" && value.baseUrl !== "")
					.map(([name]) => name);
				if (candidates.length === 0) {
					ctx.ui.notify("models.json 里没有带 baseUrl 的 provider", "warning");
					return;
				}
				providerId = await ctx.ui.select("同步哪个 provider？", candidates);
				if (!providerId) return;
			}

			const provider: ProviderEntry | undefined = providers[providerId];
			if (!provider) {
				ctx.ui.notify(`models.json 里没有 provider "${providerId}"`, "error");
				return;
			}
			if (typeof provider.baseUrl !== "string" || provider.baseUrl === "") {
				ctx.ui.notify(`provider "${providerId}" 没有 baseUrl，无法同步`, "error");
				return;
			}
			if (!Array.isArray(provider.models)) provider.models = [];

			const controller = new AbortController();
			let plan: SyncPlan;
			try {
				const liveIds = await fetchLiveModels(provider, controller.signal);
				const catalog = await loadCatalog(agentDir, controller.signal);
				plan = planSync(provider, liveIds, catalog);
				const report = formatReport(providerId, plan, liveIds.length);
				ctx.ui.notify(report, "info");

				if (dryRun) {
					ctx.ui.notify("--dry-run：models.json 未改动", "info");
					return;
				}

				// 重新读一遍，避免把同步期间的其它编辑覆盖掉。
				const latest = readFile();
				const backupPath = `${filePath}.bak-${timestamp()}`;
				fs.writeFileSync(backupPath, fs.readFileSync(filePath));
				latest.providers = latest.providers ?? {};
				latest.providers[providerId] = { ...latest.providers[providerId], models: plan.nextModels };
				fs.writeFileSync(filePath, `${JSON.stringify(latest, null, 2)}\n`);

				// refresh 的结果是 errors: Map<providerId, Error>，不是单个 error。
				const result = await ctx.modelRegistry.refresh({ allowNetwork: false });
				const failure =
					result?.errors?.get(providerId)?.message ?? ctx.modelRegistry.getError();
				ctx.ui.notify(
					failure
						? `已写入 ${path.basename(backupPath)} 备份，但热加载失败: ${failure}`
						: `已写入 models.json（备份 ${path.basename(backupPath)}），模型清单已热加载`,
					failure ? "warning" : "info",
				);
			} catch (error) {
				const message = describeError(error);
				ctx.ui.notify(`同步中止，models.json 未改动: ${message}`, "error");
			}
		},
	});
}
