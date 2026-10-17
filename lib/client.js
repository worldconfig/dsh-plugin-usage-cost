/**
 * dsh-plugin-usage-cost — session-header usage/cost HUD for DeepSeek Harness.
 *
 * 作者 / Author: 烟雨如梦
 * 原始仓库 / Original: https://github.com/worldconfig/dsh-plugin-usage-cost
 * SPDX-License-Identifier: MIT
 *
 * 本文件为作者原创代码，保留此署名以便溯源；转载、分发或二次开发请保留本注释。
 */
/**
 * 版权指纹：作者 烟雨如梦 · 插件 dsh-plugin-usage-cost · 许可证 MIT。
 * 字符串里含零宽字符（U+200B、U+2060），肉眼不可见，但会跟随代码一起被复制。
 * 它是署名的一部分：改代码时请原样保留，不要“清理”或重排这一行。
 * @type {string}
 */
const AUTHOR_FINGERPRINT = "​烟雨如梦⁠dsh-plugin-usage-cost⁠MIT​";

window.__ModuleLoader__.load({
	id: "dsh-plugin-usage-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");

		/**
		 * React requires a key on every element rendered from a children array. This
		 * component builds its rows as literal arrays of text and spans, so rather than
		 * threading keys through dozens of literals, stamp an index key on each element
		 * that lacks one. These lists never reorder, so the position is the identity.
		 * @param children - one element's children, array or single.
		 * @returns the same children with keys where React needs them.
		 */
		const keyed = (children) =>
			Array.isArray(children)
				? children.map((child, index) =>
						child !== null && typeof child === "object" && !Array.isArray(child) && (child.key === undefined || child.key === null)
							? react.cloneElement(child, { key: "p" + index })
							: child
					)
				: children;

		const jsx = {
			Fragment: jsxRuntime.Fragment,
			jsx: (type, props, key) => jsxRuntime.jsx(type, { ...(props || {}), children: keyed((props || {}).children) }, key),
			jsxs: (type, props, key) => jsxRuntime.jsxs(type, { ...(props || {}), children: keyed((props || {}).children) }, key)
		};

		//#region 价格表 —— 取自 DeepSeek 官方价目表（api-docs.deepseek.com/zh-cn/quick_start/pricing）
		/**
		 * 单价，单位：元 / 百万 token（1e6）。
		 *
		 *   input      未缓存输入（缓存未命中）
		 *   cacheRead  缓存命中读取
		 *   output     输出
		 *   cacheWrite 官方没有单独定价，写入按未命中输入计（下面自动补）
		 *
		 * 官方是「峰谷双价」：北京时间周一至周五 9:00-12:00、14:00-18:00（不含法定节假日）
		 * 为高峰时段，其余全部为空闲时段，空闲价 = 高峰价的一半。
		 */
		const CURRENCY = "￥";
		const PRICES = {
			"deepseek-flash": {
				peak: { input: 2, cacheRead: 0.04, output: 8 },
				offPeak: { input: 1, cacheRead: 0.02, output: 4 }
			},
			"deepseek-v4-pro": {
				peak: { input: 9, cacheRead: 0.3, output: 27 },
				offPeak: { input: 4.5, cacheRead: 0.15, output: 13.5 }
			}
		};

		/** 价目来源与核对日期：浮层里显示，用来判断这份常量是否该重新对一遍官网。 */
		const PRICE_SOURCE = {
			url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
			verifiedOn: "2026-10-17"
		};

		/** 官方页「模型版本」行的兜底副本；抓取成功时会被官网的最新值覆盖。 */
		const BUILTIN_VERSIONS = {
			"deepseek-flash": "DeepSeek-V4.1-Flash-1017",
			"deepseek-v4-pro": "DeepSeek-V4-Pro-0813"
		};

		/** 偏差阈值：单价表估算与实测均价相差超过这个比例，就判定价目可能已过期。 */
		const PRICE_DRIFT_LIMIT = 0.35;

		/** 中国法定节假日，格式 YYYY-MM-DD；补上后这些日期整天空闲价。 */
		const HOLIDAYS = new Set([]);

		const BEIJING_TZ = "Asia/Shanghai";
		let beijingFormatter;

		/** Beijing wall-clock pieces (year/month/day/hour/minute) for one instant. */
		function beijingParts(date) {
			beijingFormatter =
				beijingFormatter ??
				new Intl.DateTimeFormat("en-CA", {
					timeZone: BEIJING_TZ,
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					hourCycle: "h23"
				});
			const parts = {};
			for (const part of beijingFormatter.formatToParts(date)) parts[part.type] = part.value;
			return parts;
		}

		/** Whether one instant bills at the peak rate. */
		function isPeak(date) {
			const parts = beijingParts(date);
			const key = parts.year + "-" + parts.month + "-" + parts.day;
			if (HOLIDAYS.has(key)) return false;
			const dayIndex = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
			if (dayIndex === 0 || dayIndex === 6) return false;
			const hour = Number(parts.hour) % 24;
			return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
		}

		/** Short label for the billing window plus the Beijing clock it was judged on. */
		function billingWindowLabel(date) {
			const parts = beijingParts(date);
			return (isPeak(date) ? "高峰" : "空闲") + "（北京时间 " + parts.hour + ":" + parts.minute + "）";
		}
		//#endregion

		const BUCKETS = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];
		const BALANCE_POLL_MS = 30000;
		const RATE_STORAGE_KEY = "dsh-usage-cost:rate-per-token";

		/** Read the learned blended rates per model from page storage. */
		function loadRates() {
			try {
				const raw = globalThis.localStorage?.getItem(RATE_STORAGE_KEY);
				const parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" ? parsed : {};
			} catch {
				return {};
			}
		}

		/** Persist the learned blended rates; storage failure keeps them page-local. */
		function saveRates(table) {
			try {
				globalThis.localStorage?.setItem(RATE_STORAGE_KEY, JSON.stringify(table));
			} catch {
				/* storage blocked: the learned rate stays in memory for this page */
			}
		}

		const PRICE_ROUTE = "/usage-cost-hud/prices";
		const PRICE_OVERRIDE_KEY = "dsh-usage-cost:price-override";
		const COLLAPSED_KEY = "dsh-usage-cost:collapsed";
		const PRICE_OVERRIDE_MAX_AGE_MS = 7 * 86400000;

		/** Whether the user folded the HUD down to one number. */
		function loadCollapsed() {
			try {
				return globalThis.localStorage?.getItem(COLLAPSED_KEY) === "1";
			} catch {
				return false;
			}
		}

		/** Persist the folded preference so it survives reloads. */
		function saveCollapsed(value) {
			try {
				globalThis.localStorage?.setItem(COLLAPSED_KEY, value ? "1" : "0");
			} catch {
				/* storage blocked: the choice lasts for this page only */
			}
		}

		const COLOR_KEY = "dsh-usage-cost:color-mode";

		/** Whether the user picked the neutral black palette over the theme's. */
		function loadColorMode() {
			try {
				return globalThis.localStorage?.getItem(COLOR_KEY) === "black";
			} catch {
				return false;
			}
		}

		/** Persist the palette choice. */
		function saveColorMode(black) {
			try {
				globalThis.localStorage?.setItem(COLOR_KEY, black ? "black" : "theme");
			} catch {
				/* storage blocked: the choice lasts for this page only */
			}
		}

		/** Client root context captured by apply: the palette needs the theme service. */
		let uiContext;

		/**
		 * Read whether the active theme paints dark surfaces. The snapshot is a
		 * stable reference, so reading it per render costs nothing.
		 * @returns true for a dark color scheme, false when unknown.
		 */
		function prefersDark() {
			try {
				return uiContext?.get?.("theme")?.getTheme?.()?.active?.colorScheme === "dark";
			} catch {
				return false;
			}
		}

		/**
		 * CSS variable overrides for the HUD row. Redefining the theme tokens on the
		 * wrapper recolors every descendant without duplicating each style object.
		 * @param dark - active theme paints dark surfaces.
		 * @returns style additions for the row container.
		 */
		function paletteRowVars(dark) {
			return {
				"--dsw-alias-label-secondary": dark ? "#ffffff" : "#000000",
				"--dsw-alias-label-tertiary": dark ? "rgba(255,255,255,0.78)" : "rgba(0,0,0,0.72)",
				"--dsw-alias-bg-layer-2": dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.08)",
				"--dsw-alias-state-error-primary": dark ? "#ff9a9a" : "#c62828"
			};
		}

		/**
		 * CSS variable overrides for the hover panel: an opaque black sheet with
		 * neutral light text, so the panel reads the same in either theme.
		 * @returns style additions for the panel container.
		 */
		function palettePanelVars() {
			return {
				"--dsw-alias-bg-base": "#000000",
				"--dsw-alias-bg-overlay": "#000000",
				"--dsw-specific-menu": "transparent",
				"--dsw-alias-border-l1": "#333333",
				"--dsw-alias-border-l2": "#2b2b2b",
				"--dsw-alias-label-secondary": "#ececec",
				"--dsw-alias-label-tertiary": "#a8a8a8",
				"--dsw-alias-label-caption": "#8f8f8f",
				"--dsw-alias-state-error-primary": "#ff9a9a"
			};
		}

		const POSITION_KEY = "dsh-usage-cost:position";
		/** Where the HUD lives: header utilities, composer dock, or a fixed corner pill. */
		const POSITIONS = ["header", "composer", "overlay"];
		const POSITION_LABELS = { header: "顶部", composer: "输入框下", overlay: "右下角" };

		/** Read the saved placement; anything unknown falls back to the header. */
		function loadPosition() {
			try {
				const value = globalThis.localStorage?.getItem(POSITION_KEY);
				return POSITIONS.includes(value) ? value : "header";
			} catch {
				return "header";
			}
		}

		/** Persist the placement. */
		function savePosition(value) {
			try {
				globalThis.localStorage?.setItem(POSITION_KEY, value);
			} catch {
				/* storage blocked: the choice lasts for this page only */
			}
		}

		/**
		 * Every mounted instance renders from the same saved placement, so switching
		 * from one seat must tell the others: they live in different slots and cannot
		 * observe each other's state.
		 */
		const positionListeners = new Set();

		/** @param listener - receives the new placement. @returns unsubscribe. */
		function subscribePosition(listener) {
			positionListeners.add(listener);
			return () => positionListeners.delete(listener);
		}

		/** @param value - the placement every instance should follow. */
		function publishPosition(value) {
			for (const listener of positionListeners) listener(value);
		}

		const SPOT_KEY = "dsh-usage-cost:spot";
		/** Keep the pill at least this far from every window edge. */
		const SPOT_MARGIN = 8;
		/**
		 * The top strip of the Desktop window is window chrome: a drag region where the
		 * pointer belongs to the OS and never reaches the page. A pill parked there is
		 * visible but dead, so the pill never settles above this inset.
		 */
		const SPOT_TOP = 48;

		/** Read the dragged corner-pill position; undefined means the default corner. */
		function loadSpot() {
			try {
				const raw = globalThis.localStorage?.getItem(SPOT_KEY);
				const parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" && Number.isFinite(parsed.x) && Number.isFinite(parsed.y) ? { x: parsed.x, y: parsed.y } : undefined;
			} catch {
				return undefined;
			}
		}

		/** Persist the dragged position. */
		function saveSpot(value) {
			try {
				globalThis.localStorage?.setItem(SPOT_KEY, JSON.stringify(value));
			} catch {
				/* storage blocked: the position lasts for this page only */
			}
		}

		const TODAY_KEY = "dsh-usage-cost:today";

		/**
		 * Local calendar day, so the daily counter resets at the user's own midnight
		 * instead of UTC's.
		 * @param now - instant to label; defaults to the current one.
		 * @returns `YYYY-MM-DD` in local time.
		 */
		function todayKey(now = new Date()) {
			const month = String(now.getMonth() + 1).padStart(2, "0");
			const day = String(now.getDate()).padStart(2, "0");
			return now.getFullYear() + "-" + month + "-" + day;
		}

		/** Read the persisted daily counter; undefined when absent or malformed. */
		function loadToday() {
			try {
				const raw = globalThis.localStorage?.getItem(TODAY_KEY);
				const parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || typeof parsed.date !== "string" || !Number.isFinite(parsed.spend)) return undefined;
				return { date: parsed.date, spend: Number(parsed.spend), last: Number.isFinite(parsed.last) ? Number(parsed.last) : undefined };
			} catch {
				return undefined;
			}
		}

		/** Persist the daily counter. */
		function saveToday(value) {
			try {
				globalThis.localStorage?.setItem(TODAY_KEY, JSON.stringify(value));
			} catch {
				/* storage blocked: the counter lasts for this page only */
			}
		}

		const TURN_BASE_KEY = "dsh-usage-cost:turn-base";

		/**
		 * Read the last turn observation. It lets a reloaded page (or the other seat)
		 * recover the current turn's start total instead of hiding 本轮 until the next
		 * turn boundary.
		 * @returns `{ sessionId, at, running, total, turnStart? }`, or undefined.
		 */
		function loadTurnBase() {
			try {
				const raw = globalThis.localStorage?.getItem(TURN_BASE_KEY);
				const parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return undefined;
				if (typeof parsed.sessionId !== "string" || typeof parsed.running !== "boolean" || !Number.isFinite(parsed.at) || !Number.isFinite(parsed.total)) return undefined;
				return {
					sessionId: parsed.sessionId,
					at: Number(parsed.at),
					running: parsed.running,
					total: Number(parsed.total),
					// The turn start is a full usage snapshot, not a total: turn deltas are
					// computed per bucket, so a number here would be read as an empty base.
					turnStart: parsed.turnStart !== null && typeof parsed.turnStart === "object" ? parsed.turnStart : undefined
				};
			} catch {
				return undefined;
			}
		}

		/** Persist one turn observation. */
		function saveTurnBase(value) {
			try {
				globalThis.localStorage?.setItem(TURN_BASE_KEY, JSON.stringify(value));
			} catch {
				/* storage blocked: the choice lasts for this page only */
			}
		}

		/**
		 * Fold one balance observation into today's spend. A drop is spend; a rise is a
		 * top-up, so it only rebases the comparison instead of counting as negative
		 * spend. The first observation of a day is the baseline, not a charge.
		 * @param stored - previously persisted counter, or undefined.
		 * @param total - current balance total.
		 * @returns the counter to persist and show.
		 */
		function advanceToday(stored, total) {
			const date = todayKey();
			if (stored === undefined || stored.date !== date) return { date, spend: 0, last: total };
			const spend = Number.isFinite(stored.spend) ? stored.spend : 0;
			if (!Number.isFinite(stored.last)) return { date, spend, last: total };
			return total < stored.last ? { date, spend: spend + (stored.last - total), last: total } : { date, spend, last: total };
		}

		const FIELDS_KEY = "dsh-usage-cost:fields";
		/** One toggle per text element the row can show; the controls stay permanent. */
		const FIELD_KEYS = ["turn", "session", "balance", "spend", "today", "running"];
		const FIELD_LABELS = { turn: "本轮", session: "会话", balance: "余额", spend: "↓", today: "今日", running: "运行中" };
		/**
		 * CSS that must exist independently of React's inline styles:
		 *
		 * 1. The header row cannot shrink (its container is `flex: none`), so a narrow
		 *    pane would push it past the right corner. These container queries drop the
		 *    least important elements as space runs out; the seat attribute keeps them
		 *    from touching the composer dock or the corner pill.
		 * 2. The Desktop window marks its chrome (title strip) as an app-drag region.
		 *    A pill dragged up there would swallow every pointer event, so the HUD's
		 *    own boxes opt out of dragging and stay clickable.
		 */
		const HUD_CSS = [
			"@container (max-width: 920px){[data-uc-hud-seat=header] [data-uc-hud-field=today]{display:none}}",
			"@container (max-width: 860px){[data-uc-hud-seat=header] [data-uc-hud-field=turn]{display:none}}",
			"@container (max-width: 800px){[data-uc-hud-seat=header] [data-uc-hud-field=spend]{display:none}}",
			"@container (max-width: 740px){[data-uc-hud-seat=header] [data-uc-hud-field=running]{display:none}}",
			"@container (max-width: 680px){[data-uc-hud-seat=header] [data-uc-hud-field=balance]{display:none}}",
			"[data-uc-hud-seat]{-webkit-app-region:no-drag}",
			"[data-uc-hud-pill]{-webkit-app-region:no-drag}",
			"[data-uc-hud-panel]{-webkit-app-region:no-drag}"
		].join("\n");
		const DEFAULT_FIELDS = {
			expanded: { turn: true, session: true, balance: true, spend: true, today: true, running: true },
			// The folded row keeps the session pair by default: its tokens and amount are
			// exactly what a glance is for.
			collapsed: { turn: false, session: true, balance: false, spend: false, today: false, running: false }
		};

		/** Read the per-state element visibility, falling back per field on defaults. */
		function loadFields() {
			let stored;
			try {
				const raw = globalThis.localStorage?.getItem(FIELDS_KEY);
				stored = raw === null || raw === undefined ? undefined : JSON.parse(raw);
			} catch {
				stored = undefined;
			}
			const pick = (state) => {
				const source = stored !== null && typeof stored === "object" && stored[state] !== null && typeof stored[state] === "object" ? stored[state] : {};
				const merged = {};
				for (const key of FIELD_KEYS) merged[key] = typeof source[key] === "boolean" ? source[key] : DEFAULT_FIELDS[state][key];
				return merged;
			};
			return { expanded: pick("expanded"), collapsed: pick("collapsed") };
		}

		/** Persist the per-state element visibility. */
		function saveFields(value) {
			try {
				globalThis.localStorage?.setItem(FIELDS_KEY, JSON.stringify(value));
			} catch {
				/* storage blocked: the choice lasts for this page only */
			}
		}

		/**
		 * Whether two field sets are identical. Re-reads compare first, so a seat that
		 * finds nothing new keeps its state reference and never re-renders.
		 * @param a - first set. @param b - second set.
		 * @returns true when every switch matches.
		 */
		function sameFields(a, b) {
			return FIELD_KEYS.every((key) => a.expanded[key] === b.expanded[key] && a.collapsed[key] === b.collapsed[key]);
		}

		/** Prices fetched from the official page through the host route. */
		let priceOverride = loadPriceOverride();

		/** Read the persisted fetched-price table. */
		function loadPriceOverride() {
			try {
				const raw = globalThis.localStorage?.getItem(PRICE_OVERRIDE_KEY);
				const parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" && parsed.models !== undefined ? parsed : undefined;
			} catch {
				return undefined;
			}
		}

		/** Persist the fetched-price table so a reload keeps it. */
		function savePriceOverride(value) {
			try {
				globalThis.localStorage?.setItem(PRICE_OVERRIDE_KEY, JSON.stringify(value));
			} catch {
				/* storage blocked: the fetched prices apply to this page only */
			}
		}

		/** Total billed tokens of one usage value. */
		function totalOf(usage) {
			let sum = 0;
			for (const key of BUCKETS) sum += usage[key] ?? 0;
			return sum;
		}

		/** Per-bucket difference of two usage values, never negative. */
		function diffOf(usage, base) {
			const out = {};
			for (const key of BUCKETS) out[key] = Math.max(0, (usage[key] ?? 0) - (base?.[key] ?? 0));
			return out;
		}

		/** Price row for a model id, or undefined when no row carries numbers. */
		function priceEntryOf(model) {
			if (model === undefined) return undefined;
			const fetched = priceOverride?.models?.[model];
			if (fetched !== undefined) return fetched;
			return PRICES[model];
		}

		/** Official DeepSeek routes are the only ones this plugin prices. */
		function isOfficialProvider(provider) {
			return typeof provider === "string" && /^deepseek(?:-|$)/.test(provider);
		}

		/** Human-facing build name for a model id, from the fetched page or the built-in copy. */
		function modelDisplayName(model) {
			if (model === undefined || model === null) return "未知";
			const fetched = priceOverride?.versions?.[model];
			if (typeof fetched === "string" && fetched.length > 0) return fetched;
			return BUILTIN_VERSIONS[model] ?? String(model);
		}

		/** Reasoning effort as the composer prints it: first letter capitalised. */
		function formatEffort(effort) {
			if (typeof effort !== "string" || effort.length === 0) return undefined;
			return effort.charAt(0).toUpperCase() + effort.slice(1);
		}

		/**
		 * Read the active route out of the modelSelection projection. The projection has
		 * carried `next` in some builds and `{ lastUsed, pending }` in others, so accept
		 * all three instead of relying on one shape.
		 * @param selection - projection value, possibly undefined.
		 * @returns the provider, model id, and reasoning effort currently in effect.
		 */
		function selectionOf(selection) {
			const route = selection?.next ?? selection?.lastUsed ?? selection?.pending;
			return {
				provider: route?.provider,
				model: route?.model,
				effort: route?.reasoningEffort
			};
		}

		function priceRowOf(model, date) {
			const entry = priceEntryOf(model);
			if (entry === undefined) return undefined;
			const tier = isPeak(date) ? entry.peak : entry.offPeak;
			if (tier === undefined || typeof tier.input !== "number") return undefined;
			return { ...tier, cacheWrite: tier.cacheWrite ?? tier.input };
		}

		/** Estimated cost of one usage value under a price row, undefined when unpriced. */
		function costOf(usage, row) {
			if (row === undefined) return undefined;
			return (
				((usage.uncachedInputTokens ?? 0) * (row.input ?? 0) +
					(usage.cacheReadTokens ?? 0) * (row.cacheRead ?? row.input ?? 0) +
					(usage.cacheWriteTokens ?? 0) * (row.cacheWrite ?? row.input ?? 0) +
					(usage.outputTokens ?? 0) * (row.output ?? 0)) /
				1e6
			);
		}

		/** Compact token count. */
		function formatTokens(value) {
			const amount = Number(value ?? 0);
			if (!Number.isFinite(amount)) return "0";
			if (amount < 1000) return String(amount);
			if (amount < 1e6) return (amount / 1000).toFixed(amount < 1e4 ? 1 : 0) + "k";
			return (amount / 1e6).toFixed(2) + "M";
		}

		/** Exact count with thousands separators, for the detail panel. */
		function formatCount(value) {
			const amount = Number(value ?? 0);
			return Number.isFinite(amount) ? amount.toLocaleString("en-US") : "0";
		}

		/** Money with enough decimals to stay meaningful for tiny deltas. */
		function formatMoney(value) {
			if (value === undefined || value === null || !Number.isFinite(value)) return CURRENCY + "—";
			if (value === 0) return CURRENCY + "0";
			if (value < 0.01) return CURRENCY + value.toFixed(4);
			return CURRENCY + value.toFixed(2);
		}

		/** Sum one currency across a wallet list. */
		function walletSum(list, currency) {
			let sum = 0;
			for (const wallet of list ?? []) {
				if (wallet?.currency !== currency) continue;
				const amount = Number(wallet.balance);
				if (Number.isFinite(amount)) sum += amount;
			}
			return sum;
		}

		/** Client build version the account remote expects; matches the shipped app bundle. */
		const CLIENT_VERSION = "0.2.1-rc.2";

		/**
		 * Resolve the account remote without declaring it as a required service:
		 * cordis throws on `ctx.remote` when the fiber never injected it, while
		 * `ctx.get()` reads the store without that requirement.
		 * @param ctx - Client root context.
		 * @returns the account namespace, or undefined when unavailable.
		 */
		function accountNamespaceOf(ctx) {
			if (typeof ctx?.get !== "function") return undefined;
			const direct = ctx.get("remote.account");
			if (typeof direct?.getBalance === "function") return direct;
			const remote = ctx.get("remote");
			return typeof remote?.account?.getBalance === "function" ? remote.account : undefined;
		}

		/**
		 * Reader over the Host account-balance remote: recharge wallet plus bonus
		 * wallets, sampled on demand. Reports the cause on failure so the HUD can
		 * show it instead of a bare dash.
		 * @param ctx - Client root context, dereferenced lazily.
		 * @returns an async reader resolving `{ ok: true, recharge, bonus, total }` or `{ ok: false, reason }`.
		 */
		function createBalanceReader(ctx) {
			return async function readBalance() {
				let namespace;
				try {
					namespace = accountNamespaceOf(ctx);
				} catch (error) {
					return { ok: false, reason: "remote lookup threw: " + String(error?.message ?? error) };
				}
				if (namespace === undefined) return { ok: false, reason: "account remote not mounted" };
				const client = {
					version: CLIENT_VERSION,
					locale: (typeof navigator !== "undefined" && navigator.language) || "zh-CN",
					timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
				};
				let outcome;
				try {
					outcome = await namespace.getBalance(client);
				} catch (error) {
					return { ok: false, reason: "call threw: " + String(error?.message ?? error) };
				}
				if (outcome === null || outcome === undefined) return { ok: false, reason: "empty response" };
				if (outcome.ok !== true) return { ok: false, reason: "rejected: " + String(outcome.error?.message ?? outcome.error?.code ?? "unknown") };
				const result = outcome.value;
				if (result === null || result === undefined) return { ok: false, reason: "no account (signed out?)" };
				if (result.status !== "ready") return { ok: false, reason: "status " + String(result.status) };
				const recharge = walletSum(result.value, "CNY");
				const bonus = walletSum(result.bonusWallets, "CNY");
				return { ok: true, recharge, bonus, total: recharge + bonus };
			};
		}

		// `flex: none` keeps the row at its natural width: the header's utilities block
		// is already `flex: none`, and the session title (`flex: 1; min-width: 0`) is
		// the element that gives up width first, never the left-side buttons.
		const wrapStyle = { display: "inline-flex", alignItems: "center", gap: "12px", fontSize: "12px", whiteSpace: "nowrap", flex: "none" };
		const dimStyle = { color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))", fontVariantNumeric: "tabular-nums" };
		const numStyle = { color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" };
		const spendStyle = { color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums", opacity: 0.9 };
		const errorStyle = { color: "var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary))", fontVariantNumeric: "tabular-nums" };
		const busyStyle = { color: "var(--dsw-alias-label-secondary)" };
		/**
		 * The corner seat escapes its slot's flow without a portal. The surface is the
		 * theme base (not the overlay scrim, which is dark in every theme and once left
		 * dark text on a black bar), and the palette toggle overrides it to #000.
		 */
		const overlaySpotStyle = {
			position: "fixed",
			right: "16px",
			// Clear the composer card (and its send button) instead of sitting on it.
			bottom: "84px",
			zIndex: 1100,
			display: "inline-flex",
			alignItems: "center",
			maxWidth: "calc(100vw - 16px)",
			padding: "5px 10px",
			borderRadius: "999px",
			backgroundColor: "var(--dsw-alias-bg-base, #ffffff)",
			border: "0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))",
			boxShadow: "0 8px 24px rgba(0,0,0,.28)",
			userSelect: "none",
			touchAction: "none"
		};

		const panelStyle = {
			position: "fixed",
			zIndex: 1200,
			boxSizing: "border-box",
			borderRadius: "var(--dsw-radius-lg, 12px)",
			// The theme's menu surface is only 45–58% opaque and leans on a 40px
			// backdrop blur. Painting it over an opaque base keeps the tint without
			// letting the conversation behind bleed through the numbers.
			backgroundColor: "var(--dsw-alias-bg-base, #1b1c20)",
			backgroundImage: "linear-gradient(var(--dsw-specific-menu, transparent), var(--dsw-specific-menu, transparent))",
			border: "0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32))",
			boxShadow: "var(--dsw-elevation-prominent, 0 16px 40px rgba(0,0,0,.4))",
			color: "var(--dsw-alias-label-secondary, #b8b8b8)",
			padding: "12px 14px",
			fontSize: "12px",
			lineHeight: "20px",
			maxHeight: "min(70vh, 560px)",
			overflowY: "auto",
			cursor: "default",
			whiteSpace: "normal",
			textAlign: "left"
		};
		const panelGroupStyle = { padding: "6px 0 2px" };
		const panelGroupTitleStyle = {
			color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)))",
			fontSize: "10px",
			letterSpacing: "0.06em",
			marginBottom: "2px"
		};
		const panelRowStyle = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "18px" };
		const panelLabelStyle = { color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))", flex: "none" };
		const panelValueStyle = {
			color: "var(--dsw-alias-label-secondary, #b8b8b8)",
			fontVariantNumeric: "tabular-nums",
			textAlign: "right",
			minWidth: 0,
			overflowWrap: "anywhere"
		};
		const panelValueErrorStyle = { ...panelValueStyle, color: "var(--dsw-alias-state-error-primary, #e06c6c)" };
		const panelMutedStyle = { ...panelValueStyle, color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))" };
		const panelFootnoteStyle = {
			color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)))",
			fontSize: "11px",
			paddingTop: "2px"
		};

		/**
		 * Build one HUD instance bound to one balance reader and one seat.
		 * @param readBalance - account balance reader created by the plugin apply.
		 * @param placement - `header` utilities or the composer `dock` (which also hosts
		 *   the fixed corner pill), so an inactive seat can render nothing.
		 * @returns the occupant component.
		 */
		function createUsageCostHud(readBalance, placement) {
			return function UsageCostHud(props) {
				const useSession = props.useSession;
				const useProjection = props.useProjection;
				const running = useSession === undefined ? false : useSession((snapshot) => snapshot.running);
				const usage = useProjection === undefined ? undefined : useProjection("tokenUsage");
				const selection = useProjection === undefined ? undefined : useProjection("modelSelection");

				const [balance, setBalance] = react.useState(undefined);
				const [today, setToday] = react.useState(loadToday);
				const [fields, setFields] = react.useState(loadFields);
				const [fieldsOpen, setFieldsOpen] = react.useState(false);
				const [balanceError, setBalanceError] = react.useState(undefined);
				const latestBalance = react.useRef(undefined);
				const baselineBalance = react.useRef(undefined);
				const usageBaseline = react.useRef(undefined);
				const wasRunning = react.useRef(false);
				const primed = react.useRef(false);
				const lastBalanceError = react.useRef(undefined);
				const lastBaseSave = react.useRef(0);
				const [, setBaselineTick] = react.useState(0);
				const sessionId = props.sessionId;
				const [learnedRates, setLearnedRates] = react.useState(loadRates);
				const calibratedFor = react.useRef(undefined);
				const [priceMeta, setPriceMeta] = react.useState(priceOverride);
				const [priceBusy, setPriceBusy] = react.useState(false);
				const [priceError, setPriceError] = react.useState(undefined);
				const [flash, setFlash] = react.useState(undefined);
				const [collapsed, setCollapsed] = react.useState(loadCollapsed);
				const [blackMode, setBlackMode] = react.useState(loadColorMode);
				const [position, setPosition] = react.useState(loadPosition);
				react.useEffect(() => subscribePosition(setPosition), []);
				// The dock seat also owns the fixed pill, so it stays mounted for both
				// non-header placements while the header seat retires.
				const active = placement === "header" ? position === "header" : position !== "header";
				const floating = placement === "dock" && position === "overlay";
				// The other seat may have edited the saved preferences while this one was
				// hidden; re-read them whenever this seat becomes the visible one. Each
				// setter keeps the current reference when nothing changed, so becoming
				// active with unchanged settings costs no extra render.
				react.useEffect(() => {
					if (!active) return;
					setFields((current) => {
						const next = loadFields();
						return sameFields(current, next) ? current : next;
					});
					setBlackMode((current) => {
						const next = loadColorMode();
						return current === next ? current : next;
					});
					setCollapsed((current) => {
						const next = loadCollapsed();
						return current === next ? current : next;
					});
				}, [active]);
				const [spot, setSpot] = react.useState(loadSpot);
				const [dragging, setDragging] = react.useState(false);
				const dragOrigin = react.useRef(undefined);
				const darkTheme = prefersDark();
				// On the corner pill the row sits on its own black sheet, so it must take
				// the panel palette (light text). The page palette would paint black on
				// black: the pill's wrapper is black in this mode, the row text is not.
				const rowVars = blackMode ? (floating ? palettePanelVars() : paletteRowVars(darkTheme)) : undefined;
				const panelVars = blackMode ? palettePanelVars() : undefined;
				const flashTimer = react.useRef(undefined);
				const alive = react.useRef(true);
				react.useEffect(() => {
					alive.current = true;
					return () => {
						alive.current = false;
					};
				}, []);

				/** Show a transient result chip so a click never ends in silence. */
				const showFlash = react.useCallback((kind, text) => {
					if (flashTimer.current !== undefined) clearTimeout(flashTimer.current);
					setFlash({ kind, text });
					flashTimer.current = setTimeout(() => {
						flashTimer.current = undefined;
						setFlash(undefined);
					}, kind === "ok" ? 5000 : 9000);
				}, []);
				react.useEffect(
					() => () => {
						if (flashTimer.current !== undefined) clearTimeout(flashTimer.current);
					},
					[]
				);

				const hudRef = react.useRef(null);
				const [panelOpen, setPanelOpen] = react.useState(false);
				const [panelPos, setPanelPos] = react.useState(undefined);
				const hoverTimer = react.useRef(undefined);

				/** Keep the panel open across the gap between the HUD and the panel. */
				const openPanel = react.useCallback(() => {
					if (hoverTimer.current !== undefined) {
						clearTimeout(hoverTimer.current);
						hoverTimer.current = undefined;
					}
					setPanelOpen(true);
				}, []);
				const schedulePanelClose = react.useCallback(() => {
					if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
					hoverTimer.current = setTimeout(() => {
						hoverTimer.current = undefined;
						setPanelOpen(false);
					}, 140);
				}, []);
				react.useEffect(
					() => () => {
						if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
					},
					[]
				);

				/** Start a drag from the pill body; buttons keep their own clicks. */
				const beginDrag = react.useCallback(
					(event) => {
						if (!floating) return;
						if (event.button !== undefined && event.button !== 0) return;
						const target = event.target;
						if (target !== null && typeof target?.closest === "function" && (target.closest("button") !== null || target.closest("[data-uc-hud-panel]") !== null)) return;
						const element = hudRef.current;
						if (element === null || typeof window === "undefined") return;
						const rect = element.getBoundingClientRect();
						dragOrigin.current = {
							dx: event.clientX - rect.left,
							dy: event.clientY - rect.top,
							width: rect.width,
							height: rect.height
						};
						setDragging(true);
						if (typeof event.preventDefault === "function") event.preventDefault();
					},
					[floating]
				);

				// A drag follows the pointer on the window, not the pill: the pointer must
				// keep tracking even when it leaves the pill's 20px-tall box.
				react.useEffect(() => {
					if (!dragging || typeof window === "undefined") return;
					const move = (event) => {
						const origin = dragOrigin.current;
						if (origin === undefined) return;
						const maxX = Math.max(SPOT_MARGIN, window.innerWidth - origin.width - SPOT_MARGIN);
						const maxY = Math.max(SPOT_TOP, window.innerHeight - origin.height - SPOT_MARGIN);
						setSpot({
							x: Math.min(Math.max(SPOT_MARGIN, event.clientX - origin.dx), maxX),
							y: Math.min(Math.max(SPOT_TOP, event.clientY - origin.dy), maxY)
						});
					};
					const end = () => {
						dragOrigin.current = undefined;
						setDragging(false);
					};
					window.addEventListener("pointermove", move);
					window.addEventListener("pointerup", end);
					window.addEventListener("pointercancel", end);
					// Losing focus (alt-tab, a system dialog) can swallow the pointerup;
					// without this the pill would stay glued to the cursor.
					window.addEventListener("blur", end);
					return () => {
						window.removeEventListener("pointermove", move);
						window.removeEventListener("pointerup", end);
						window.removeEventListener("pointercancel", end);
						window.removeEventListener("blur", end);
					};
				}, [dragging]);

				/** One write per settled position, not per pointermove. */
				react.useEffect(() => {
					if (dragging || spot === undefined) return;
					saveSpot(spot);
				}, [dragging, spot]);

				// A dragged pill must stay reachable after the app window shrinks.
				react.useEffect(() => {
					if (typeof window === "undefined") return;
					const clamp = () => {
						const element = hudRef.current;
						if (element === null) return;
						const rect = element.getBoundingClientRect();
						const maxX = Math.max(SPOT_MARGIN, window.innerWidth - rect.width - SPOT_MARGIN);
						const maxY = Math.max(SPOT_TOP, window.innerHeight - rect.height - SPOT_MARGIN);
						setSpot((current) => {
							if (current === undefined) return current;
							const x = Math.min(Math.max(SPOT_MARGIN, current.x), maxX);
							// A pill saved before this rule, or dragged up there, is pulled
							// back below the window chrome so it stays clickable.
							const y = Math.min(Math.max(SPOT_TOP, current.y), maxY);
							return x === current.x && y === current.y ? current : { x, y };
						});
					};
					window.addEventListener("resize", clamp);
					clamp();
					return () => window.removeEventListener("resize", clamp);
				}, []);

				const placePanel = react.useCallback(() => {
					const element = hudRef.current;
					if (element === null || typeof window === "undefined") return;
					const rect = element.getBoundingClientRect();
					const width = Math.min(420, window.innerWidth - 24);
					const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
					// Open toward the roomier side. The composer dock and the bottom-right
					// pill have their space above, while the header seat and a pill dragged
					// near the top have it below; capping to that side never pushes the panel
					// past the window edge.
					const below = window.innerHeight - rect.bottom - 16;
					const above = rect.top - 16;
					if (below >= above) {
						setPanelPos({ top: rect.bottom + 8, left, width, maxHeight: Math.max(96, Math.min(560, below)) });
						return;
					}
					setPanelPos({ bottom: window.innerHeight - rect.top + 8, left, width, maxHeight: Math.max(96, Math.min(560, above)) });
				}, []);
				react.useEffect(() => {
					if (!panelOpen) return;
					placePanel();
					const reposition = () => placePanel();
					window.addEventListener("resize", reposition);
					window.addEventListener("scroll", reposition, true);
					return () => {
						window.removeEventListener("resize", reposition);
						window.removeEventListener("scroll", reposition, true);
					};
				}, [panelOpen, placePanel]);

				// Ask the host half for a fresh copy of the official price page; it answers
				// same-origin because the docs site sends no CORS headers.
				const refreshPrices = react.useCallback(async (quiet = false) => {
					if (!quiet) setPriceBusy(true);
					try {
						const response = await fetch(PRICE_ROUTE, { headers: { accept: "application/json" } });
						const payload = await response.json();
						if (!alive.current) return;
						if (payload?.ok === true && payload.models !== undefined) {
							priceOverride = {
								models: payload.models,
								versions: payload.versions,
								fetchedAt: payload.fetchedAt,
								pageModified: payload.pageModified,
								source: payload.source
							};
							savePriceOverride(priceOverride);
							setPriceMeta(priceOverride);
							setPriceError(undefined);
							const stamp = new Date().toTimeString().slice(0, 5);
							if (!quiet) showFlash("ok", "价目已更新 " + stamp + " · " + Object.keys(payload.models).length + " 个模型");
						} else {
							setPriceError(String(payload?.reason ?? "HTTP " + response.status));
							if (!quiet) showFlash("error", "抓取失败");
							console.warn("[usage-cost-hud] price refresh failed:", payload?.reason ?? response.status);
						}
					} catch (error) {
						if (alive.current) {
							setPriceError(String(error?.message ?? error));
							if (!quiet) showFlash("error", "抓取失败：" + String(error?.message ?? error));
						}
						console.warn("[usage-cost-hud] price refresh failed:", error?.message ?? error);
					} finally {
						if (!quiet && alive.current) setPriceBusy(false);
					}
				}, [showFlash]);

				react.useEffect(() => {
					if (!active) return;
					const fetchedAt = priceOverride?.fetchedAt;
					const age = fetchedAt === undefined ? Infinity : Date.now() - Date.parse(fetchedAt);
					if (!(age < PRICE_OVERRIDE_MAX_AGE_MS)) refreshPrices(true);
				}, [active, refreshPrices]);

				/** Guards overlapping reads: the poll timer and the turn-end read can collide. */
				const sampling = react.useRef(false);
				const sample = react.useCallback(async () => {
					if (sampling.current) return;
					sampling.current = true;
					try {
						let next;
						try {
							next = await readBalance();
						} catch (error) {
							next = { ok: false, reason: String(error?.message ?? error) };
						}
						if (next === undefined || !alive.current) return;
						if (!next.ok) {
							if (next.reason !== lastBalanceError.current) {
								lastBalanceError.current = next.reason;
								console.warn("[usage-cost-hud] balance unavailable:", next.reason);
							}
							setBalanceError(next.reason);
							return;
						}
						lastBalanceError.current = undefined;
						setBalanceError(undefined);
						latestBalance.current = next;
						setBalance(next);
						// Re-read storage first: another seat may have sampled since this
						// instance mounted, and the stored counter is the shared truth.
						const folded = advanceToday(loadToday(), next.total);
						saveToday(folded);
						setToday(folded);
					} finally {
						sampling.current = false;
					}
				}, [readBalance]);

				react.useEffect(() => {
					if (!active) return;
					sample();
				}, [active, sample]);

				react.useEffect(() => {
					if (!active || !running) return;
					sample();
					const timer = setInterval(sample, BALANCE_POLL_MS);
					return () => clearInterval(timer);
				}, [active, running, sample]);

				// One delayed read after a turn ends, so the debit it just caused is
				// visible to the rate calibration instead of waiting for the next turn.
				react.useEffect(() => {
					if (!active || running) return;
					const timer = setTimeout(sample, 2000);
					return () => clearTimeout(timer);
				}, [active, running, sample]);

				// A different Session can reuse this component position, so its baselines
				// must never leak into the new one. The guard also keeps the effect inert on
				// every ordinary render.
				const baseSession = react.useRef(sessionId);
				react.useEffect(() => {
					if (baseSession.current === sessionId) return;
					baseSession.current = sessionId;
					primed.current = false;
					wasRunning.current = false;
					usageBaseline.current = undefined;
					baselineBalance.current = undefined;
				}, [sessionId]);

				react.useEffect(() => {
					// A page loaded mid-turn must not claim "本轮 0": the first observation
					// only primes the edge detector, so a baseline is taken at the next real
					// false ?true transition.
					if (!primed.current) {
						primed.current = true;
						wasRunning.current = running;
						return;
					}
					if (running && !wasRunning.current) {
						usageBaseline.current = usage;
						if (latestBalance.current !== undefined) baselineBalance.current = latestBalance.current.total;
						// Record the turn start at the edge itself: a reload right after the
						// edge would otherwise lose it and hide 本轮 for the whole turn.
						if (typeof sessionId === "string") saveTurnBase({ sessionId, at: Date.now(), running: true, total: totalOf(usage), turnStart: totalOf(usage) });
					}
					wasRunning.current = running;
				}, [running, usage, sessionId]);

				// Recover the current turn after a reload or a seat switch: the previous
				// instance stored the turn-start total, and the Session is still on it.
				// Only a running observation is trusted (an idle one means a new turn may
				// have started since), and only when it is recent.
				react.useEffect(() => {
					if (!active || !running || usage === undefined || usageBaseline.current !== undefined) return;
					const base = loadTurnBase();
					if (base === undefined || base.sessionId !== sessionId || base.running !== true) return;
					if (base.turnStart === undefined || totalOf(base.turnStart) > totalOf(usage)) return;
					if (!(Date.now() - base.at < 10 * 60 * 1000)) return;
					usageBaseline.current = base.turnStart;
					setBaselineTick((value) => (value + 1) % 1000000);
				}, [active, running, usage, sessionId]);

				// Keep the stored observation fresh while the turn runs (throttled), and
				// mark the session idle when it ends so a stale turn start is never reused.
				react.useEffect(() => {
					if (!active || sessionId === undefined || usage === undefined) return;
					const now = Date.now();
					if (running && now - lastBaseSave.current < 2000) return;
					lastBaseSave.current = now;
					const total = totalOf(usage);
					if (running) saveTurnBase({ sessionId, at: now, running: true, total, turnStart: usageBaseline.current });
					else saveTurnBase({ sessionId, at: now, running: false, total });
				}, [active, running, usage, sessionId]);

				// Learn a blended ?token rate from a finished turn: its real balance
				// delta over its own token count. Kept per model and smoothed (EMA) so
				// one odd turn cannot swing the estimate.
				react.useEffect(() => {
					if (running) return;
					if (balance === undefined || baselineBalance.current === undefined || usageBaseline.current === undefined) return;
					if (calibratedFor.current === balance.total) return;
					const turn = diffOf(usage, usageBaseline.current);
					const tokens = totalOf(turn);
					const spentNow = baselineBalance.current - balance.total;
					if (!(tokens > 0) || !(spentNow > 0)) return;
					calibratedFor.current = balance.total;
					const observed = spentNow / tokens;
					// The balance is account-wide: when the implied rate is far from the
					// official table, another Session (or a subagent, or a wallet change)
					// polluted the delta — skip the sample instead of poisoning the rate.
					const route = selectionOf(selection);
					const priceRow = isOfficialProvider(route.provider) ? priceRowOf(route.model, new Date()) : undefined;
					const tableCost = priceRow === undefined ? undefined : costOf(turn, priceRow);
					if (tableCost !== undefined && tableCost > 0) {
						const tableRate = tableCost / tokens;
						if (observed > tableRate * 2.5 || observed < tableRate * 0.4) return;
					}
					setLearnedRates((previous) => {
						const table = previous ?? {};
						const key = selection?.next?.model ?? "default";
						const known = typeof table[key] === "number" ? table[key] : undefined;
						const blended = known === undefined ? observed : (known * 2 + observed) / 3;
						const next = { ...table, [key]: blended };
						saveRates(next);
						return next;
					});
				}, [running, balance, usage, selection]);

				// Minute tick: peak/off-peak pricing flips on wall-clock boundaries even
				// while nothing else about the session changes.
				const [, setClockTick] = react.useState(0);
				react.useEffect(() => {
					const timer = setInterval(() => setClockTick((value) => (value + 1) % 1000000), 60000);
					return () => clearInterval(timer);
				}, []);

				// An official model the table does not know yet: pull the price page once so
				// a newly integrated model prices itself, and never nag about the same route.
				const unlistedProbe = react.useRef(undefined);
				const officialModel = selection?.next?.provider;
				const officialName = selection?.next?.model;
				const officialUnknown = isOfficialProvider(officialModel) && priceRowOf(officialName, new Date()) === undefined;
				react.useEffect(() => {
					if (!active || !officialUnknown) return;
					const key = String(officialModel) + "/" + String(officialName);
					if (unlistedProbe.current === key) return;
					const fetchedAt = priceOverride?.fetchedAt;
					const age = fetchedAt === undefined ? Infinity : Date.now() - Date.parse(fetchedAt);
					if (age < 3600000) {
						unlistedProbe.current = key;
						return;
					}
					unlistedProbe.current = key;
					console.warn("[usage-cost-hud] unpriced official model, refreshing price page:", key);
					refreshPrices(true);
				}, [active, officialUnknown, officialModel, officialName, refreshPrices]);

				// Every seat renders the same row; only the saved placement's seat paints
				// it, so switching seats never leaves two HUDs on screen.
				if (!active) return null;

				/** Wrap the row in the draggable corner pill when the overlay seat is chosen. */
				const frame = (node) =>
					floating
						? jsx.jsx("span", {
								"data-uc-hud-pill": "",
								style: {
									...overlaySpotStyle,
									...(blackMode ? palettePanelVars() : {}),
									...(spot === undefined ? undefined : { left: spot.x + "px", top: spot.y + "px", right: "auto", bottom: "auto" }),
									cursor: dragging ? "grabbing" : "grab"
								},
								onPointerDown: beginDrag,
								children: node
							})
						: node;

				// Never vanish: an absent tokenUsage projection (model switch, reconnect,
				// cold reopen) used to return null and make the whole HUD disappear with no
				// explanation. Show the gap instead, keeping the balance readable.
				if (usage === undefined) {
					return frame(jsx.jsxs("span", {
						role: "group",
						style: { ...wrapStyle, ...rowVars },
						title: "tokenUsage 投影暂不可用（切换模型或重连时可能出现，随后会自动恢复）",
						children: [
							jsx.jsx("span", { style: dimStyle, children: "用量 读取中…" }),
							jsx.jsx("span", {
								style: dimStyle,
								children: ["余额 ", jsx.jsx("span", { style: numStyle, children: formatMoney(balance?.total) })]
							})
						]
					}));
				}

				const now = new Date();
				const route = selectionOf(selection);
				const provider = route.provider;
				const model = route.model;
				const official = isOfficialProvider(provider);
				const row = official ? priceRowOf(model, now) : undefined;
				const unlistedOfficial = official && row === undefined;
				const hasTurn = usageBaseline.current !== undefined;
				const turnUsage = hasTurn ? diffOf(usage, usageBaseline.current) : undefined;
				const total = totalOf(usage);
				const learnedRate =
					official && typeof learnedRates[model ?? "default"] === "number" ? learnedRates[model ?? "default"] : undefined;
				const estimate = costOf(usage, row);
				const modeled = learnedRate === undefined ? undefined : total * learnedRate;
				// The learned rate comes from an account-level balance delta divided by one
				// Session's tokens, so another Session, a subagent or a wallet change lands
				// in that delta as if it were this Session's spend. A rate far from the
				// official table is that contamination, not a stale price: it must never
				// override the table or raise the "price may be stale" warning.
				const samplePlausible = estimate === undefined || modeled === undefined || (modeled <= estimate * 2 && modeled >= estimate * 0.5);
				const drift =
					estimate === undefined || modeled === undefined || modeled <= 0 || total < 200000 || !samplePlausible
						? undefined
						: (estimate - modeled) / modeled;
				const priceStale = drift !== undefined && Math.abs(drift) > PRICE_DRIFT_LIMIT;
				const sampleSuspect = learnedRate !== undefined && estimate !== undefined && estimate > 0 && !samplePlausible;
				const sessionEstimate = priceStale ? modeled : (estimate ?? (unlistedOfficial ? undefined : modeled));
				const estimateSource = !official
					? "第三方模型·不计价"
					: priceStale
						? "按实测均价推算·价目可能过期"
						: row === undefined
							? "价目未收录·不计价"
							: sampleSuspect
								? "按单价表推算·实测样本异常（可能含其它会话消耗）"
								: "按单价表推算";
				let turnEstimate;
				if (turnUsage !== undefined) {
					const fromTable = costOf(turnUsage, row);
					if (priceStale && learnedRate !== undefined) turnEstimate = totalOf(turnUsage) * learnedRate;
					else if (fromTable !== undefined) turnEstimate = fromTable;
					else if (official && !unlistedOfficial && learnedRate !== undefined) turnEstimate = totalOf(turnUsage) * learnedRate;
				}
				const spent =
					baselineBalance.current !== undefined && balance !== undefined ? Math.max(0, baselineBalance.current - balance.total) : undefined;
				// Hide yesterday's counter during the first render of a new day; the next
				// balance sample rebases it.
				const todaySpend = today !== undefined && today.date === todayKey() ? today.spend : undefined;

				// One snippet per configurable element, so the folded and expanded rows
				// share formatting and differ only in which snippets they include.
				const turnSpan =
					turnUsage === undefined
						? null
						: jsx.jsxs("span", {
								style: dimStyle,
								children: [
									"本轮 ",
									jsx.jsx("span", { style: numStyle, children: formatTokens(totalOf(turnUsage)) }),
									turnEstimate === undefined
										? null
										: jsx.jsxs(jsx.Fragment, {
												children: [" · 估 ", jsx.jsx("span", { style: numStyle, children: formatMoney(turnEstimate) })]
											})
								]
							});
				const sessionSpan = jsx.jsxs("span", {
					style: dimStyle,
					children: [
						"会话 ",
						jsx.jsx("span", { style: numStyle, children: formatTokens(total) }),
						sessionEstimate === undefined
							? null
							: jsx.jsxs(jsx.Fragment, {
									children: [
										" · 估 ",
										jsx.jsx("span", { style: numStyle, children: formatMoney(sessionEstimate) }),
										priceStale ? jsx.jsx("span", { style: spendStyle, children: " ⚠" }) : null
									]
								})
					]
				});
				const balanceSpan = jsx.jsxs("span", {
					style: dimStyle,
					children:
						balance === undefined
							? ["余额 ", jsx.jsx("span", { style: spendStyle, children: balanceError === undefined ? "读取中" : "读取失败" })]
							: ["余额 ", jsx.jsx("span", { style: numStyle, children: formatMoney(balance.total) })]
				});
				const spendSpan =
					spent === undefined || spent <= 0
						? null
						: jsx.jsxs("span", {
								style: dimStyle,
								title: "本轮真实扣费（余额差值）",
								children: ["↓", jsx.jsx("span", { style: spendStyle, children: formatMoney(spent) })]
							});
				const todaySpan = jsx.jsxs("span", {
					style: dimStyle,
					title: "今日已扣费：按本机观察到的余额下降累计（充值只重设基准，不冲抵）",
					children: ["今日 ", jsx.jsx("span", { style: numStyle, children: formatMoney(todaySpend) })]
				});
				const runningSpan = running ? jsx.jsx("span", { style: busyStyle, children: "● 运行中" }) : null;
				const unpricedSpan = unlistedOfficial
					? jsx.jsx("span", { key: "unpriced", style: spendStyle, title: "官网价目里还没有 " + String(model) + "，已自动尝试拉取最新价目", children: "价目未收录" })
					: null;
				const snippetOf = (key) => {
					const node = { turn: turnSpan, session: sessionSpan, balance: balanceSpan, spend: spendSpan, today: todaySpan, running: runningSpan }[key];
					return node === null || node === undefined ? null : jsx.jsx("span", { key, "data-uc-hud-field": key, children: node });
				};
				/** @param visible - one state's switches. @param keys - element order. @returns the enabled snippets. */
				const visibleParts = (visible, keys) => keys.filter((key) => visible[key]).map(snippetOf).filter((part) => part !== null);
				// Some elements are empty until there is data (a fresh turn, a charge, a
				// running session); the editor marks those chips so "nothing happened"
				// never looks like a broken switch.
				const fieldHasData = {
					turn: turnUsage !== undefined,
					session: true,
					balance: true,
					spend: spent !== undefined && spent > 0,
					today: todaySpend !== undefined,
					running
				};
				const priceStatus = priceBusy
					? jsx.jsx("span", { key: "status", style: dimStyle, children: "抓取中…" })
					: flash !== undefined
						? jsx.jsx("span", {
								key: "status",
								style: flash.kind === "ok" ? numStyle : errorStyle,
								title: flash.kind === "ok" ? "价目已更新为官网最新数据" : "抓取失败：" + String(priceError ?? ""),
								children: (flash.kind === "ok" ? "✓ " : "✗ ") + flash.text
							})
						: priceError === undefined
							? null
							: jsx.jsx("span", {
									key: "status",
									style: errorStyle,
									title: "价目抓取失败：" + priceError + "　（点右侧 ⟳! 重试）",
									children: "价目失败"
								});
				const refreshButton = jsx.jsx("button", {
					key: "refresh",
					type: "button",
					onClick: () => refreshPrices(),
					disabled: priceBusy,
					"aria-label": "重新抓取价目",
					title: priceError === undefined ? "从 DeepSeek 官网重新抓取价目（宿主侧抓取，同源返回）" : "上次抓取失败：" + priceError + "　点击重试",
					style: {
						background: "transparent",
						border: "none",
						padding: "0 2px",
						margin: 0,
						font: "inherit",
						fontSize: "12px",
						lineHeight: 1,
						color: priceError === undefined ? "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))" : "var(--dsw-alias-state-error-primary, var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)))",
						cursor: priceBusy ? "default" : "pointer",
						opacity: priceBusy ? 0.6 : 1
					},
					children: priceBusy ? "…" : priceError === undefined ? "⟳" : "⟳!"
				});
				const verifiedAt = Date.parse(PRICE_SOURCE.verifiedOn + "T00:00:00+08:00");
				const priceAgeDays = Number.isFinite(verifiedAt) ? Math.max(0, Math.round((now.getTime() - verifiedAt) / 86400000)) : undefined;

				const tokenText = (count, unit) =>
					formatCount(count) + (unit === undefined ? "" : " × " + formatMoney(unit) + "/M");

				const detailGroups = [
					{
						title: "会话",
						items: [
							{ label: "模型", value: modelDisplayName(model) },
							model !== undefined && model !== null && modelDisplayName(model) !== String(model)
								? { label: "模型 id", value: String(model), tone: "muted" }
								: null,
							{ label: "路由", value: String(provider ?? "未知") },
							formatEffort(route.effort) === undefined
								? null
								: { label: "推理", value: formatEffort(route.effort) },
							official ? { label: "计价时段", value: billingWindowLabel(now) } : { label: "计价", value: "仅官方路由", tone: "muted" },
							{ label: "会话 token", value: formatCount(total) }
						].filter(Boolean)
					},
					{
						title: "TOKEN 分项",
						items: [
							{ label: "未缓存输入", value: tokenText(usage.uncachedInputTokens, row?.input) },
							{ label: "缓存读取", value: tokenText(usage.cacheReadTokens, row?.cacheRead) },
							{ label: "缓存写入", value: tokenText(usage.cacheWriteTokens, row?.cacheWrite) },
							{ label: "输出", value: tokenText(usage.outputTokens, row?.output) }
						]
					},
					{
						title: "金额",
						items: [
							{ label: "本轮估价", value: turnEstimate === undefined ? "—" : formatMoney(turnEstimate) },
							{ label: "会话估价", value: sessionEstimate === undefined ? "—" : formatMoney(sessionEstimate) },
							{ label: "本次消耗", value: spent === undefined ? "—" : formatMoney(spent), hint: "余额差值" },
							{ label: "今日消耗", value: todaySpend === undefined ? "—" : formatMoney(todaySpend), hint: "余额累计" },
							learnedRate === undefined
								? null
								: { label: "实测均价", value: formatMoney(learnedRate * 1e6) + " / M", tone: sampleSuspect ? "muted" : undefined, hint: sampleSuspect ? "参考，未用于计价" : undefined }
						].filter(Boolean),
						footnote: estimateSource
					},
					{
						title: "账户",
						items:
							balance === undefined
								? [{ label: "余额", value: balanceError === undefined ? "读取中" : "读取失败", tone: "error" }]
								: [
										{ label: "余额", value: formatMoney(balance.total) },
										{ label: "充值", value: formatMoney(balance.recharge) },
										{ label: "赠金", value: formatMoney(balance.bonus) }
									]
					},
					{
						title: "价目",
						items: [
							{
								label: "来源",
								value: priceMeta?.fetchedAt === undefined ? "内置常量" : "官网抓取 " + priceMeta.fetchedAt.slice(0, 10)
							},
							{ label: "核对", value: PRICE_SOURCE.verifiedOn + (priceAgeDays === undefined ? "" : " · " + priceAgeDays + " 天前") },
							{
								label: "偏差",
								value: sampleSuspect ? "样本异常" : drift === undefined ? "样本不足" : (drift >= 0 ? "+" : "") + (drift * 100).toFixed(0) + "%",
								tone: priceStale ? "error" : sampleSuspect ? "muted" : undefined,
								hint: sampleSuspect ? "可能含其它会话" : undefined
							},
							unlistedOfficial ? { label: "缺口", value: "该模型未收录", tone: "error" } : null,
							priceError === undefined ? null : { label: "刷新", value: "失败 · " + priceError, tone: "error" }
						].filter(Boolean)
					}
				];

				// Folded view: one number plus the affordance to unfold, for users who
				// find the full row too wide. Hover still opens the detail panel.
				// The disclosure control is a real icon button: the text glyphs ▸/▾
				// shrank to an unreadable speck at header font sizes.
				const foldToggle = jsx.jsx("button", {
					key: "fold",
					type: "button",
					onClick: () => {
						const next = !collapsed;
						setCollapsed(next);
						saveCollapsed(next);
					},
					title: collapsed ? "展开用量条" : "折叠用量条",
					"aria-label": collapsed ? "展开用量条" : "折叠用量条",
					"aria-expanded": collapsed ? "false" : "true",
					style: {
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						flex: "none",
						width: "20px",
						height: "20px",
						padding: 0,
						margin: 0,
						border: "none",
						borderRadius: "6px",
						background: "transparent",
						color: "var(--dsw-alias-label-secondary)",
						cursor: "pointer",
						transition: "background-color 120ms ease"
					},
					onMouseEnter: (event) => {
						event.currentTarget.style.backgroundColor = "var(--dsw-alias-bg-layer-2)";
					},
					onMouseLeave: (event) => {
						event.currentTarget.style.backgroundColor = "transparent";
					},
					children: jsx.jsx("svg", {
						viewBox: "0 0 16 16",
						width: 14,
						height: 14,
						"aria-hidden": true,
						focusable: "false",
						style: {
							display: "block",
							transform: collapsed ? "none" : "rotate(180deg)",
							transition: "transform 150ms ease"
						},
						children: jsx.jsx("path", {
							d: "M4 6.25 L8 10.25 L12 6.25",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: 1.7,
							strokeLinecap: "round",
							strokeLinejoin: "round"
						})
					})
				});

				// Preferences live in the panel footer: the header row is too tight, and a
				// settings page row would be heavier than these two compact choices.
				const footerRowStyle = {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "16px"
				};
				const footerButtonStyle = {
					background: "transparent",
					border: "none",
					padding: 0,
					margin: 0,
					font: "inherit",
					color: "var(--dsw-alias-label-secondary)",
					cursor: "pointer",
					textDecoration: "underline",
					textUnderlineOffset: "2px"
				};
				/**
				 * @param on - whether the element is visible.
				 * @param hasData - whether it can paint anything right now.
				 * @returns the chip's style; an enabled-but-empty chip is dashed.
				 */
				const chipStyle = (on, hasData) => ({
					padding: "1px 7px",
					borderRadius: "999px",
					border: on && !hasData ? "0.5px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.35))" : "0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
					background: on ? "var(--dsw-alias-label-secondary)" : "transparent",
					opacity: on && !hasData ? 0.55 : 1,
					color: on ? "var(--dsw-alias-bg-base)" : "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))",
					font: "inherit",
					fontSize: "11px",
					lineHeight: "16px",
					cursor: "pointer"
				});
				/** One labeled row of element chips for one state. */
				const fieldRow = (label, state) => {
					const current = state === (collapsed ? "collapsed" : "expanded");
					return jsx.jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
						children: [
							jsx.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))", flex: "none", width: "56px" }, children: label + (current ? " 当前" : "") }),
							...FIELD_KEYS.map((key) => {
								const on = fields[state][key];
								const hasData = fieldHasData[key];
								return jsx.jsx(
									"button",
									{
										type: "button",
										"data-field": state + ":" + key,
										onClick: () => {
											const next = { ...fields, [state]: { ...fields[state], [key]: !fields[state][key] } };
											setFields(next);
											saveFields(next);
										},
										"aria-pressed": on,
										title: on ? (hasData ? "隐藏「" + FIELD_LABELS[key] + "」" : "已开启，但当前没有数据可显示") : "显示「" + FIELD_LABELS[key] + "」",
										style: chipStyle(on, hasData),
										children: FIELD_LABELS[key]
									},
									key
								);
							})
						]
					});
				};
				const panelFooter = jsx.jsxs("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "6px",
						marginTop: "8px",
						paddingTop: "8px",
						borderTop: "0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
						fontSize: "11px"
					},
					children: [
						jsx.jsxs("div", {
							style: footerRowStyle,
							children: [
								jsx.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))" }, children: "配色" }),
								jsx.jsx("button", {
									type: "button",
									onClick: () => {
										const next = !blackMode;
										setBlackMode(next);
										saveColorMode(next);
									},
									title: blackMode ? "当前为纯黑配色，点击改为跟随主题" : "当前跟随主题，点击改为纯黑",
									"aria-pressed": blackMode,
									style: footerButtonStyle,
									children: blackMode ? "纯黑" : "跟随主题"
								})
							]
						}),
						jsx.jsxs("div", {
							style: footerRowStyle,
							children: [
								jsx.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))" }, children: "位置" }),
								jsx.jsx("button", {
									type: "button",
									onClick: () => {
										const index = POSITIONS.indexOf(position);
										const next = POSITIONS[(index + 1) % POSITIONS.length];
										setPosition(next);
										savePosition(next);
										publishPosition(next);
									},
									title: "点击切换：顶部 → 输入框下 → 右下角（当前：" + POSITION_LABELS[position] + "）",
									style: footerButtonStyle,
									children: POSITION_LABELS[position]
								})
							]
						}),
						jsx.jsxs("div", {
							style: footerRowStyle,
							children: [
								jsx.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))" }, children: "显示" }),
								jsx.jsx("button", {
									type: "button",
									onClick: () => setFieldsOpen((open) => !open),
									title: "选择展开 / 折叠时要显示的文本元素",
									style: footerButtonStyle,
									children: fieldsOpen ? "收起" : "编辑"
								})
							]
						}),
						fieldsOpen
							? jsx.jsxs("div", {
									style: { display: "flex", flexDirection: "column", gap: "4px" },
									children: [
										fieldRow("展开", "expanded"),
										fieldRow("折叠", "collapsed"),
										jsx.jsx("div", {
											style: { color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))", opacity: 0.85, fontSize: "10px", lineHeight: "14px" },
											children: "两套互相独立，点一下即生效；虚线 = 已开启但当前没有数据（本轮还没开始、↓ 还没扣费、空闲时没有「运行中」）。"
										})
									]
								})
							: null
					]
				});

				if (collapsed) {
					return frame(jsx.jsxs("span", {
						ref: hudRef,
						role: "group",
						"data-uc-hud-seat": placement,
						style: { ...wrapStyle, ...rowVars },
						onMouseEnter: openPanel,
						onMouseLeave: schedulePanelClose,
						children: [jsx.jsx("style", { key: "auto-hide", children: HUD_CSS }), ...visibleParts(fields.collapsed, FIELD_KEYS), foldToggle]
					}));
				}

				return frame(jsx.jsxs(jsx.Fragment, {
					children: [
						jsx.jsxs("span", {
							key: "row",
							ref: hudRef,
							role: "group",
							"data-uc-hud-seat": placement,
							"aria-label":
								"会话用量与花费：" +
								(turnUsage === undefined ? "" : "本轮 " + formatTokens(totalOf(turnUsage)) + " token，") +
								"会话 " +
								formatTokens(total) +
								" token，余额 " +
								formatMoney(balance?.total),
							style: { ...wrapStyle, ...rowVars },
							onMouseEnter: openPanel,
							onMouseLeave: schedulePanelClose,
							children: [
								jsx.jsx("style", { key: "auto-hide", children: HUD_CSS }),
								...visibleParts(fields.expanded, ["turn", "session"]),
								unpricedSpan,
								...visibleParts(fields.expanded, ["balance", "spend", "today"]),
								priceStatus,
								refreshButton,
								...visibleParts(fields.expanded, ["running"]),
								foldToggle
							]
						}),
						panelOpen && panelPos !== undefined
							? jsx.jsx("div", {
									key: "panel",
									"data-uc-hud-panel": "",
									style: {
										...panelStyle,
										...panelVars,
										...(panelPos.maxHeight === undefined ? undefined : { maxHeight: panelPos.maxHeight }),
										top: panelPos.top,
										bottom: panelPos.bottom,
										left: panelPos.left,
										width: panelPos.width
									},
									onMouseEnter: openPanel,
									onMouseLeave: schedulePanelClose,
									children: [detailGroups.map((group) =>
										jsx.jsxs(
											"div",
											{
												style: panelGroupStyle,
												children: [
													jsx.jsx("div", { key: "title", style: panelGroupTitleStyle, children: group.title }),
													...group.items.map((item) =>
														jsx.jsxs(
															"div",
															{
																style: panelRowStyle,
																children: [
																	jsx.jsx("span", { style: panelLabelStyle, children: item.label }),
																	jsx.jsxs("span", {
																		style:
																			item.tone === "error"
																				? panelValueErrorStyle
																				: item.tone === "muted"
																					? panelMutedStyle
																					: panelValueStyle,
																		children:
																			item.hint === undefined
																				? item.value
																				: [
																						item.value,
																						jsx.jsx("span", { style: panelFootnoteStyle, children: " · " + item.hint })
																					]
																	})
																]
															},
															item.label
														)
													),
													group.footnote === undefined
														? null
														: jsx.jsx("div", { style: panelFootnoteStyle, children: group.footnote })
												]
											},
											group.title
										)
									),
									panelFooter
								]
							})
							: null
					]
				}));
			};
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots"];

		/**
		 * Fill the selected seat with the HUD. Both seats stay registered so a
		 * placement switch is a state change, not a re-registration: the inactive one
		 * renders nothing.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			uiContext = ctx;
			const readBalance = createBalanceReader(ctx);
			const seats = [
				["conversation.session.header.utilities", "header", "usage-cost-hud", 30],
				["conversation.composer.dock", "dock", "usage-cost-hud-dock", 10]
			];
			for (const [name, placement, id, order] of seats) {
				ctx.slots.inject(name, () =>
					ctx.slots.register({ name, id, order }, createUsageCostHud(readBalance, placement))
				);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		// Attribution travels with the bundle; the loader ignores extra exports.
		exports.author = AUTHOR_FINGERPRINT;
		return module.exports;
	}
});

