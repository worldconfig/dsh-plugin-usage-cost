/**
 * dsh-plugin-usage-cost — host half of the usage/cost HUD.
 *
 * 作者 / Author: 烟雨如梦
 * 原始仓库 / Original: https://github.com/worldconfig/dsh-plugin-usage-cost
 * SPDX-License-Identifier: MIT
 *
 * 本文件为作者原创代码，保留此署名以便溯源；转载、分发或二次开发请保留本注释。
 *
 * The browser half needs the official price list, but `api-docs.deepseek.com`
 * sends no CORS headers (its preflight answers 403), so a page fetch is always
 * blocked. This half fetches and parses the page in Node and republishes the
 * result on a same-origin route the client bundle can read.
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const ROUTE = "/usage-cost-hud/prices";
const CACHE_MS = 10 * 60 * 1000;
/** A failed attempt must not lock the button out for the full success window. */
const FAILURE_CACHE_MS = 15 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/** Last parse, kept for a short while so a reload burst costs one outgoing request. */
let cached;
/** Shared in-flight attempt, so concurrent callers cannot race the cache. */
let inflight;

/**
 * 版权指纹：作者 烟雨如梦 · 插件 dsh-plugin-usage-cost · 许可证 MIT。
 * 字符串里含零宽字符（U+200B、U+2060），肉眼不可见，但会跟随代码一起被复制。
 * 它是署名的一部分：改代码时请原样保留，不要“清理”或重排这一行。
 * @type {string}
 */
export const author = "​烟雨如梦⁠dsh-plugin-usage-cost⁠MIT​";

/** Lifecycle breadcrumbs so a stuck route can be diagnosed offline. */
const STATUS_FILE = join(process.env.DSH_HOME ?? tmpdir(), "usage-cost-host-status.json");
const STATUS_FALLBACK = new URL("./usage-cost-host-status.json", import.meta.url);
let statusRecord = {};

/**
 * Persist one lifecycle breadcrumb; diagnostics never break the plugin.
 * @param stage - where the host half currently is.
 * @param extra - additional facts to record.
 */
async function report(stage, extra = {}) {
	statusRecord = { author: "烟雨如梦", ...statusRecord, stage, at: new Date().toISOString(), ...extra };
	let body;
	try {
		body = JSON.stringify(statusRecord, null, 2);
	} catch {
		return;
	}
	try {
		await writeFile(STATUS_FILE, body, "utf8");
	} catch {
		// DSH_HOME may be outside this process's write scope; keep the breadcrumb next
		// to the package so a failed registration is still diagnosable.
		try {
			await writeFile(STATUS_FALLBACK, body, "utf8");
		} catch {
			/* diagnostics are best-effort */
		}
	}
}

/**
 * Flatten markup into the `|`-separated token stream the price table renders as.
 * @param html - raw page source.
 * @returns normalised text with one `|` between former element boundaries.
 */
function flatten(html) {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, "|")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\|+/g, "|")
		.replace(/[ \t]+/g, " ");
}

/**
 * Read the price matrix out of the documentation page.
 * The layout it depends on: a `模型` header row naming one column per model, then
 * a `价格` block whose cells run 空闲时段 / 高峰时段 for each of the three buckets.
 * @param html - raw page source.
 * @returns `{ ok: true, models, table }`, or `{ ok: false, reason }` when the layout moved.
 */
export function parsePricing(html) {
	const tokens = flatten(html)
		.split("|")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	const modelStart = tokens.indexOf("模型");
	const priceStart = tokens.indexOf("价格");
	if (modelStart === -1 || priceStart === -1) return { ok: false, reason: "layout changed: missing 模型/价格 anchors" };

	const models = [];
	for (let index = modelStart + 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.startsWith("BASE URL")) break;
		if (/^[a-z][a-z0-9.-]*$/i.test(token) && !/^\d/.test(token)) models.push(token);
	}
	if (models.length === 0) return { ok: false, reason: "layout changed: no model columns" };

	const table = {};
	for (const id of models) table[id] = { peak: {}, offPeak: {} };

	// The 模型版本 row carries the human-facing build names in the same column order,
	// e.g. `模型版本|DeepSeek-V4.1-Flash-1017|DeepSeek-V4-Pro-0813`.
	const versions = {};
	const versionStart = tokens.indexOf("模型版本");
	if (versionStart !== -1) {
		let slot = 0;
		for (let index = versionStart + 1; index < tokens.length && slot < models.length; index += 1) {
			const token = tokens[index];
			if (token === "思考模式" || token === "上下文长度") break;
			if (/^\(\d+\)$/.test(token)) continue;
			versions[models[slot]] = token;
			slot += 1;
		}
	}

	let bucket;
	let tier;
	let slot = 0;
	for (let index = priceStart; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "并发限制") break;
		if (token === "百万tokens输出") {
			bucket = "output";
			continue;
		}
		if (token === "百万tokens输入") {
			const next = tokens[index + 1] ?? "";
			bucket = next.includes("未命中") ? "input" : "cacheRead";
			index += 1;
			continue;
		}
		if (token === "空闲时段") {
			tier = "offPeak";
			slot = 0;
			continue;
		}
		if (token === "高峰时段") {
			tier = "peak";
			slot = 0;
			continue;
		}
		const amount = /^(\d+(?:\.\d+)?)元$/.exec(token);
		if (amount !== null && bucket !== undefined && tier !== undefined && slot < models.length) {
			table[models[slot]][tier][bucket] = Number(amount[1]);
			slot += 1;
		}
	}

	const complete = models.filter((id) =>
		["peak", "offPeak"].every((window) => ["input", "cacheRead", "output"].every((key) => typeof table[id][window][key] === "number"))
	);
	if (complete.length === 0) return { ok: false, reason: "layout changed: incomplete price matrix" };
	// A single incomplete column (a new model with a different table shape) must not
	// void the whole page, so drop just that column.
	const kept = {};
	for (const id of complete) kept[id] = table[id];
	const keptVersions = {};
	for (const id of complete) if (versions[id] !== undefined) keptVersions[id] = versions[id];
	return { ok: true, models: complete, table: kept, versions: keptVersions };
}

/**
 * Fetch and parse the price page, honouring the short cache. Concurrent callers —
 * the startup probe and a button click — share one in-flight request so they can
 * never race each other into overwriting the cache with a stale result.
 * @returns the payload published on the route.
 */
async function loadPricing() {
	if (cached !== undefined && Date.now() - cached.at < (cached.payload.ok ? CACHE_MS : FAILURE_CACHE_MS)) return cached.payload;
	if (inflight !== undefined) return inflight;
	inflight = fetchPricing().finally(() => {
		inflight = undefined;
	});
	return inflight;
}

/** One fresh attempt, cached on completion whatever the outcome. */
async function fetchPricing() {
	let payload;
	try {
		const response = await fetch(PRICING_URL, {
			headers: { "user-agent": "dsh-usage-cost-hud" },
			// A hung TLS connection must not hold the client's refresh open forever.
			signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined
		});
		if (!response.ok) throw new Error("HTTP " + response.status);
		const html = await response.text();
		const parsed = parsePricing(html);
		payload = parsed.ok
			? {
					ok: true,
					fetchedAt: new Date().toISOString(),
					source: PRICING_URL,
					pageModified: response.headers.get("last-modified"),
					models: parsed.table,
					versions: parsed.versions
				}
			: { ok: false, reason: parsed.reason, fetchedAt: new Date().toISOString(), source: PRICING_URL };
	} catch (error) {
		const reason = error?.name === "TimeoutError" ? "抓取超时（" + FETCH_TIMEOUT_MS / 1000 + "s）" : String(error?.message ?? error);
		payload = { ok: false, reason, fetchedAt: new Date().toISOString(), source: PRICING_URL };
	}
	cached = { at: Date.now(), payload };
	return payload;
}

/**
 * Answer the same-origin price request; the handler owns the response end to end.
 * @param req - inbound request; only the exact route path is served.
 * @param res - response to complete.
 */
async function handler(req, res) {
	const path = new URL(req.url ?? ROUTE, "http://127.0.0.1").pathname;
	if (path !== ROUTE) {
		res.statusCode = 404;
		res.end("not found");
		return;
	}
	const payload = await loadPricing();
	res.statusCode = 200;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}

/**
 * Read the browser HTTP carrier without declaring it as an injected service:
 * `ctx.get` never blocks the row, so a shell without one still mounts.
 * @param ctx - Host plugin context.
 * @returns the carrier, or undefined while it is not (yet) registered.
 */
function webServerOf(ctx) {
	try {
		const web = typeof ctx?.get === "function" ? ctx.get("webServer") : undefined;
		return web !== undefined && typeof web.register === "function" ? web : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Publish the price route when this deployment owns a browser HTTP carrier.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
	report("apply");
	let registered = false;
	/**
	 * @param web - the live HTTP carrier.
	 */
	const register = (web) => {
		if (registered) return;
		registered = true;
		const dispose = web.register({ kind: "exact", path: ROUTE, handler });
		if (typeof ctx.effect === "function") ctx.effect(() => dispose, "usage-cost-hud: price route");
		report("registered", { route: ROUTE });
		// One startup probe: the status file proves whether this host can reach the page.
		loadPricing().then((payload) =>
			report(payload.ok ? "fetch-ok" : "fetch-failed", payload.ok ? { models: Object.keys(payload.models ?? {}) } : { reason: payload.reason })
		);
	};
	// The carrier is provided by the web runtime row; a row mounted before it must
	// wait instead of giving up, otherwise the price route never appears.
	const web = webServerOf(ctx);
	if (web !== undefined) {
		register(web);
		return;
	}
	report("waiting-webserver");
	let attempts = 0;
	const timer = setInterval(() => {
		attempts += 1;
		const carrier = webServerOf(ctx);
		if (carrier !== undefined) {
			clearInterval(timer);
			register(carrier);
			return;
		}
		if (attempts < 60) return;
		clearInterval(timer);
		report("no-webserver", { note: "HTTP carrier absent after 15s: price refresh stays unavailable in this shell" });
	}, 250);
	if (typeof ctx.effect === "function") ctx.effect(() => () => clearInterval(timer), "usage-cost-hud: webserver wait");
}
