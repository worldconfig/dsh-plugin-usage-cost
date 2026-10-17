const fs = require('fs');
const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'client.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass += 1; console.log('PASS', name); } else { fail += 1; console.log('FAIL', name, '|', extra); } };
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function makeHarness(options) {
  let hookIndex = 0; const states = []; let effects = []; let dirty = false;
  const react = {
    Fragment: Symbol('Fragment'),
    useState(init) { const i = hookIndex++; if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
      return [states[i], (next) => { const v = typeof next === 'function' ? next(states[i]) : next; if (!Object.is(v, states[i])) { states[i] = v; dirty = true; } }]; },
    useRef(init) { const i = hookIndex++; if (!(i in states)) states[i] = { current: init }; return states[i]; },
    useCallback(fn) { hookIndex += 1; return fn; },
    useEffect(fn) { hookIndex += 1; effects.push(fn); },
    useMemo(fn) { hookIndex += 1; return fn(); },
    cloneElement(element, config) {
      const { key, ...rest } = config || {};
      return { ...element, key: key === undefined ? element.key : key, props: { ...element.props, ...rest } };
    }
  };
  const el = (type, props, key) => {
    const { key: propKey, ...rest } = props || {};
    return { type, props: rest, key: key === undefined ? propKey : key };
  };
  const jsxRuntime = { Fragment: react.Fragment, jsx: el, jsxs: el };
  const store = new Map();
  global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  global.navigator = { language: 'zh-CN' };
  global.setInterval = () => 0; global.clearInterval = () => {};
  global.setTimeout = () => 0; global.clearTimeout = () => {};
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, reason: 'disabled in test' }) });

  let captured;
  global.window = { __ModuleLoader__: { load: (def) => { captured = def; } }, innerWidth: 1400, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  new Function('window', 'require', 'module', 'exports', src)(global.window, (id) => (id === 'react' ? react : id === 'react/jsx-runtime' ? jsxRuntime : (() => { throw new Error(id); })()), {}, {});
  const plugin = captured.factory((id) => (id === 'react' ? react : jsxRuntime));

  const seats = new Map();
  const ctx = { get: (name) => options.provide?.(name), slots: { inject(_n, fn) { fn(); }, register(desc, C) { seats.set(desc.name, C); return () => {}; } } };
  plugin.apply(ctx);
  const occupant = seats.get('conversation.session.header.utilities');

  const state = { running: false, usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } };
  const props = {
    sessionId: 'session-test',
    useSession: (selector) => selector({ running: state.running }),
    useProjection: (key) => (key === 'tokenUsage' ? state.usage : key === 'modelSelection' ? { next: { provider: options.provider, model: options.model } } : undefined)
  };
  const assignRefs = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(assignRefs); return; }
    const p = node.props || {};
    if (p.ref && typeof p.ref === 'object') p.ref.current = { getBoundingClientRect: () => ({ right: 1200, bottom: 100, top: 70, left: 900, width: 300, height: 30 }) };
    assignRefs(p.children);
  };
  const frame = () => { hookIndex = 0; effects = []; dirty = false; const tree = occupant(props); assignRefs(tree); for (const e of effects) e(); return tree; };
  const render = () => { let tree = frame(); for (let i = 0; i < 6 && dirty; i += 1) tree = frame(); return tree; };
  return { state, render, tree: () => render() };
}

const textOf = (node) => {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && node.props) return textOf(node.props.children);
  return '';
};

(async () => {
  // --- A: official, listed, idle -> running edge, growing usage ---
  const A = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' });
  A.state.usage = { uncachedInputTokens: 1000, cacheReadTokens: 200000, cacheWriteTokens: 0, outputTokens: 5000 };
  let flat = textOf(A.render());            // idle: no 本轮
  ok('A: idle hides 本轮', !/本轮/.test(flat), flat);
  A.state.running = true;                    // turn starts: baseline is taken in the effect
  flat = textOf(A.render());
  ok('A: no misleading 本轮 0 on the edge frame', !/本轮 0/.test(flat), flat);
  A.state.usage = { uncachedInputTokens: 3000, cacheReadTokens: 2200000, cacheWriteTokens: 0, outputTokens: 60000 };
  flat = textOf(A.render());
  ok('A: 本轮 counts the delta (2.06M), not the total', /本轮 2\.06M/.test(flat), flat);
  ok('A: 会话 counts the whole log', /会话 2\.26M/.test(flat), flat);
  ok('A: official model gets an estimate', /估 ￥/.test(flat), flat);

  // --- B: third-party provider ---
  const B = makeHarness({ provider: 'bailian', model: 'qwen3.8-max' });
  B.state.usage = { uncachedInputTokens: 3000, cacheReadTokens: 2200000, cacheWriteTokens: 0, outputTokens: 60000 };
  B.state.running = true;
  const flatB = textOf(B.render());
  ok('B: third-party has no money figures', !/估 ￥/.test(flatB), flatB);
  ok('B: third-party still shows tokens', /会话 2\.26M/.test(flatB), flatB);

  // --- C: official but unlisted model ---
  const C = makeHarness({ provider: 'deepseek-account', model: 'deepseek-v5-ultra' });
  C.state.usage = { uncachedInputTokens: 3000, cacheReadTokens: 2200000, cacheWriteTokens: 0, outputTokens: 60000 };
  C.state.running = true;
  const flatC = textOf(C.render());
  ok('C: unlisted official warns', /价目未收录/.test(flatC), flatC);
  ok('C: unlisted official shows no estimate', !/估 ￥/.test(flatC), flatC);

  // --- D: balance injected ---
  const D = makeHarness({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    provide: (name) => name === 'remote.account' ? { getBalance: async () => ({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '3.19' }], bonusWallets: [{ currency: 'CNY', balance: '6.92' }] } }) } : undefined
  });
  D.state.usage = { uncachedInputTokens: 3000, cacheReadTokens: 2200000, cacheWriteTokens: 0, outputTokens: 60000 };
  D.render(); await flush();
  const flatD = textOf(D.render());
  ok('D: balance shown', /余额 ￥10\.11/.test(flatD), flatD);
  ok('D: no balance failure chip', !/读取失败/.test(flatD), flatD);

  // --- E: today's spend follows balance drops, and a top-up only rebases ---
  let wallet = 10.11;
  const E = makeHarness({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    provide: (name) => name === 'remote.account' ? { getBalance: async () => ({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: String(wallet) }], bonusWallets: [] } }) } : undefined
  });
  E.state.usage = { uncachedInputTokens: 3000, cacheReadTokens: 2200000, cacheWriteTokens: 0, outputTokens: 60000 };
  E.render(); await flush();
  wallet = 9.99;
  E.state.running = true;
  E.render(); await flush();
  E.state.running = false;
  const flatE = textOf(E.render());
  ok('E: today spend accumulates the balance drop', /今日 ￥0\.12/.test(flatE), flatE);
  wallet = 19.99;
  E.state.running = true;
  E.render(); await flush();
  E.state.running = false;
  const flatTopUp = textOf(E.render());
  ok('E: a top-up does not erase or inflate today spend', /今日 ￥0\.12/.test(flatTopUp), flatTopUp);

  // --- F: every text element can be switched off; the controls survive ---
  const F = makeHarness({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    provide: (name) => name === 'remote.account' ? { getBalance: async () => ({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '5.00' }], bonusWallets: [] } }) } : undefined
  });
  F.state.running = true;
  F.state.usage = { uncachedInputTokens: 3000, cacheReadTokens: 2200000, cacheWriteTokens: 0, outputTokens: 60000 };
  global.localStorage.setItem('dsh-usage-cost:fields', JSON.stringify({
    expanded: { turn: false, session: false, balance: false, spend: false, today: false, running: false },
    collapsed: { turn: false, session: false, balance: false, spend: false, today: false, running: false }
  }));
  F.render(); await flush();
  const flatF = textOf(F.render());
  ok('F: all text elements off leaves an empty row', !/本轮/.test(flatF) && !/会话/.test(flatF) && !/余额/.test(flatF) && !/今日/.test(flatF) && !/运行中/.test(flatF), flatF);
  ok('F: the refresh and fold controls survive', /⟳/.test(flatF), flatF);

  // --- G: a reload mid-turn recovers the turn start from storage ---
  const G = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' });
  G.state.running = true;
  G.state.usage = { uncachedInputTokens: 3000, cacheReadTokens: 2200000, cacheWriteTokens: 0, outputTokens: 60000 };
  global.localStorage.setItem('dsh-usage-cost:turn-base', JSON.stringify({ sessionId: 'session-test', at: Date.now(), running: true, total: 2263000, turnStart: { uncachedInputTokens: 1000, cacheReadTokens: 1939000, cacheWriteTokens: 0, outputTokens: 60000 } }));
  const flatG = textOf(G.render());
  ok('G: a reload mid-turn recovers 本轮 from the stored turn start', /本轮 263k/.test(flatG), flatG);

  // --- H: a stale idle observation is never reused as a turn start ---
  const H = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' });
  H.state.running = true;
  H.state.usage = { uncachedInputTokens: 3000, cacheReadTokens: 2200000, cacheWriteTokens: 0, outputTokens: 60000 };
  global.localStorage.setItem('dsh-usage-cost:turn-base', JSON.stringify({ sessionId: 'session-test', at: Date.now(), running: false, total: 2000000 }));
  const flatH = textOf(H.render());
  ok('H: an idle observation does not invent 本轮', !/本轮/.test(flatH), flatH);

  console.log('\n%d passed, %d failed', pass, fail);
  process.exit(fail === 0 ? 0 : 1);
})();

