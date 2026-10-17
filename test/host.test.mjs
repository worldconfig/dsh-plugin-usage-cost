import { readFileSync } from 'node:fs';
import { apply, parsePricing } from '../lib/index.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass += 1; console.log('PASS', name); } else { fail += 1; console.log('FAIL', name, '|', extra); } };
const html = readFileSync(new URL('./fixtures/pricing.html', import.meta.url), 'utf8');

const good = parsePricing(html);
ok('parse real page', good.ok === true, JSON.stringify(good).slice(0, 120));
ok('parse two models', good.ok && good.models.length === 2);
ok('parse flash offPeak cacheRead', good.ok && good.table['deepseek-flash'].offPeak.cacheRead === 0.02);
ok('parse flash peak output', good.ok && good.table['deepseek-flash'].peak.output === 8);
ok('parse pro peak input', good.ok && good.table['deepseek-v4-pro'].peak.input === 9);
ok('parse model versions', good.ok && good.versions['deepseek-flash'] === 'DeepSeek-V4.1-Flash-1017', JSON.stringify(good.versions));
ok('parse rejects missing anchors', parsePricing('<html>x</html>').ok === false);
ok('parse survives renamed column', parsePricing(html.replace('deepseek-v4-pro', 'deepseek-v9-ultra')).ok === true);

// fetch stubbed BEFORE mounting, so the startup probe uses the stub too
let calls = 0;
globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200, headers: { get: () => 'Sat, 17 Oct 2026 09:05:53 GMT' }, text: async () => html }; };

const mount = (mod) => {
  const holder = {};
  mod.apply({ get: (name) => (name === "webServer" ? { register(spec) { holder.spec = spec; return () => {}; } } : undefined), effect(fn) { fn(); } });
  return holder;
};
const call = async (holder, url = '/usage-cost-hud/prices') => {
  const out = { status: 0, headers: {}, body: '' };
  await holder.spec.handler({ url, method: 'GET' }, { set statusCode(v) { out.status = v; }, get statusCode() { return out.status; }, setHeader(k, v) { out.headers[k] = v; }, end(b) { out.body = String(b ?? ''); } });
  return out;
};

const holder = mount({ apply });
ok('route registered exact path', holder.spec?.kind === 'exact' && holder.spec?.path === '/usage-cost-hud/prices', JSON.stringify(holder.spec));
const r1 = await call(holder);
ok('handler 200', r1.status === 200, String(r1.status));
const payload = JSON.parse(r1.body);
ok('payload ok + 2 models', payload.ok === true && Object.keys(payload.models).length === 2);
ok('payload carries versions', payload.ok === true && payload.versions?.['deepseek-v4-pro'] === 'DeepSeek-V4-Pro-0813', JSON.stringify(payload.versions));
await call(holder);
ok('success cached (1 fetch / 2 calls)', calls === 1, 'calls=' + calls);
ok('off-path 404', (await call(holder, '/other')).status === 404);

// single-flight: startup probe + a click must share one request
calls = 0;
const single = (await import(new URL('../lib/index.js?sf=1', import.meta.url).href));
let resolveFetch;
globalThis.fetch = () => { calls += 1; return new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => html }); }); };
const holderS = mount(single);
const pendingClick = call(holderS);
resolveFetch();
await pendingClick;
ok('single-flight shares one request', calls === 1, 'calls=' + calls);

// failure path + short negative cache
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
globalThis.fetch = async () => { calls += 1; return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }; };
calls = 0;
const failMod = (await import(new URL('../lib/index.js?f=1', import.meta.url).href));
const holderF = mount(failMod);
const f1 = JSON.parse((await call(holderF)).body);
ok('failure payload ok:false with status', f1.ok === false && /503/.test(f1.reason), JSON.stringify(f1));
await call(holderF);
ok('failure short-cached', calls === 1, 'calls=' + calls);
offset = 20_000;
await call(holderF);
ok('failure retried after 15s', calls === 2, 'calls=' + calls);

// timeout wording
globalThis.fetch = async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; };
const toMod = (await import(new URL('../lib/index.js?t=1', import.meta.url).href));
const holderT = mount(toMod);
const f3 = JSON.parse((await call(holderT)).body);
ok('timeout reason is human', f3.ok === false && /超时/.test(f3.reason), JSON.stringify(f3));
Date.now = realNow;

console.log('\n%d passed, %d failed', pass, fail);
process.exit(fail === 0 ? 0 : 1);
