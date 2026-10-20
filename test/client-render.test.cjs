const fs = require('fs');
const path = require('node:path').join(__dirname, '..', 'lib', 'client.js');
const src = fs.readFileSync(path, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass += 1; console.log('PASS', name); } else { fail += 1; console.log('FAIL', name, '|', extra); } };

// ---- minimal React ----
const FRAGMENT = Symbol('Fragment');
let hookIndex = 0;
let states = [];
let effects = [];
let rerenderRequested = false;
const react = {
  Fragment: FRAGMENT,
  useState(init) {
    const i = hookIndex++;
    if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
    const set = (next) => {
      const value = typeof next === 'function' ? next(states[i]) : next;
      if (Object.is(value, states[i])) return;
      states[i] = value;
      rerenderRequested = true;
    };
    return [states[i], set];
  },
  useRef(init) {
    const i = hookIndex++;
    if (!(i in states)) states[i] = { current: init };
    return states[i];
  },
  useCallback(fn) { hookIndex += 1; return fn; },
  useEffect(fn) { hookIndex += 1; effects.push(fn); },
  useMemo(fn) { hookIndex += 1; return fn(); },
  cloneElement(element, config) {
    const { key, ...rest } = config || {};
    return { ...element, key: key ?? element.key, props: { ...element.props, ...rest } };
  }
};

// ---- minimal jsx runtime: builds a plain tree ----
// Mirrors the automatic runtime: a `key` in the props object becomes the element key
// (React extracts it, so the component can pass `key` next to other props).
const el = (type, props, key) => {
  const { key: propKey, ...rest } = props || {};
  return { type, props: rest, key: key ?? propKey };
};
const jsxRuntime = {
  Fragment: FRAGMENT,
  jsx: el,
  jsxs: el,
  jsxDEV: el
};

// ---- browser stubs ----
const windowListeners = new Map();
global.window = {
  __ModuleLoader__: null,
  innerWidth: 1400,
  innerHeight: 900,
  addEventListener(type, fn) {
    const set = windowListeners.get(type) ?? new Set();
    set.add(fn);
    windowListeners.set(type, set);
  },
  removeEventListener(type, fn) {
    windowListeners.get(type)?.delete(fn);
  },
  __fire(type, event) {
    for (const fn of [...(windowListeners.get(type) ?? [])]) fn(event);
  }
};
let captured;
global.window.__ModuleLoader__ = { load: (def) => { captured = def; } };
global.setInterval = () => 0;
global.clearInterval = () => {};
global.setTimeout = (fn) => { return 0; };
global.clearTimeout = () => {};
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v)
};
global.navigator = { language: 'zh-CN' };
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, models: { 'deepseek-flash': { peak: {}, offPeak: {} } }, fetchedAt: new Date().toISOString() }) });

// ---- load the bundle ----
const factory = new Function('window', 'require', 'module', 'exports', src + '\nreturn undefined;');
const moduleObj = { exports: {} };
factory(global.window, (id) => {
  if (id === 'react') return react;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  throw new Error('unexpected require ' + id);
}, moduleObj, moduleObj.exports);

ok('bundle registered factory', captured && captured.id === 'dsh-plugin-usage-cost');
const plugin = captured.factory((id) => (id === 'react' ? react : jsxRuntime));
ok('plugin exports apply', typeof plugin.apply === 'function');
ok('plugin injects slots', Array.isArray(plugin.inject) && plugin.inject[0] === 'slots');

// ---- capture the registered occupants ----
const seats = new Map();
const ctx = {
  get: () => undefined,
  slots: {
    inject(_name, fn) { fn(); },
    register(desc, Component) { seats.set(desc.name, { desc, Component }); return () => {}; }
  }
};
plugin.apply(ctx);
const headerSeat = seats.get('conversation.session.header.utilities');
const dockSeat = seats.get('conversation.composer.dock');
let occupant = headerSeat?.Component;
ok('occupant registered', typeof occupant === 'function');
ok('both seats registered', typeof dockSeat?.Component === 'function' && headerSeat?.desc.id === 'usage-cost-hud');

// ---- render harness ----
const now = Date.now();
const tokenUsage = { uncachedInputTokens: 374445, cacheReadTokens: 71903232, cacheWriteTokens: 0, outputTokens: 227859 };
const modelSelection = { next: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } };
const props = {
  sessionId: 'session-test',
  useSession: (selector) => selector({ running: true }),
  useProjection: (key) => (key === 'tokenUsage' ? tokenUsage : key === 'modelSelection' ? modelSelection : undefined)
};

function assignRefs(node) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(assignRefs); return; }
  const props = node.props || {};
  if (props.ref && typeof props.ref === "object") {
    props.ref.current = { getBoundingClientRect: () => ({ right: 1200, bottom: 100, top: 70, left: 900, width: 300, height: 30 }) };
  }
  assignRefs(props.children);
}
function renderOnce() {
  hookIndex = 0;
  effects = [];
  rerenderRequested = false;
  const tree = occupant(props);
  assignRefs(tree);
  for (const effect of effects) effect();
  return tree;
}
function render() {
  let tree = renderOnce();
  for (let pass = 0; pass < 6 && rerenderRequested; pass += 1) tree = renderOnce();
  return tree;
}

let tree;
try { tree = render(); } catch (error) { console.log('RENDER THREW:', error && error.stack); fail += 1; }
ok('renders without throwing', tree !== undefined && tree !== null);

// flatten text
const textOf = (node) => {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && node.props) return textOf(node.props.children);
  return '';
};
const flat = textOf(tree);
ok('HUD hides 本轮 before any turn edge (mount mid-turn)', !/本轮/.test(flat), flat.slice(0, 80));
ok('HUD shows 会话', /会话/.test(flat), flat.slice(0, 80));
ok('HUD shows 余额', /余额/.test(flat), flat.slice(0, 80));
ok('HUD has the ⟳ button text', /⟳|…/.test(flat), flat);
ok('no native title attribute on the HUD root', (() => {
  const find = (n) => {
    if (!n || !n.props) return false;
    if (n.props.title !== undefined && /模型/.test(String(n.props.title))) return true;
    const kids = n.props.children;
    return Array.isArray(kids) ? kids.some(find) : find(kids);
  };
  return !find(tree);
})());

// ---- open the panel by firing the hover handler, then re-render ----
const rootSpan = (() => {
  const kids = tree.props.children;
  return kids.find((node) => node && node.props && typeof node.props.onMouseEnter === 'function');
})();
ok('HUD root exposes hover handler', rootSpan !== undefined);
rootSpan.props.onMouseEnter();
tree = render();
const findPanelNode = (node) => {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPanelNode(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== 'object' || !node.props) return undefined;
  if (node.props['data-uc-hud-panel'] === '') return node;
  return findPanelNode(node.props.children);
};
const headerPanel = findPanelNode(tree);
ok('panel opens downward when the row sits high', headerPanel?.props?.style?.top !== undefined && headerPanel?.props?.style?.bottom === undefined, JSON.stringify(headerPanel?.props?.style));
const afterOpen = textOf(tree);
for (const label of ['会话', 'TOKEN 分项', '金额', '账户', '价目', '未缓存输入', '缓存读取', '输出', '本轮估价', '会话估价', '余额', '来源', '核对']) {
  ok('panel contains ' + label, afterOpen.includes(label), afterOpen.slice(0, 120));
}
ok('panel renders exact token counts', /374,445/.test(afterOpen) && /71,903,232/.test(afterOpen), afterOpen.slice(0, 200));
ok('panel shows model and provider', /deepseek-flash/.test(afterOpen) && /deepseek-account/.test(afterOpen));
ok('panel shows full model version', /DeepSeek-V4\.1-Flash-1017/.test(afterOpen), afterOpen.slice(0, 200));
ok('panel shows reasoning effort', /推理/.test(afterOpen) && /High/.test(afterOpen), afterOpen.slice(0, 200));
ok('panel leaks no undefined/NaN', !/undefined|NaN/.test(afterOpen), afterOpen.slice(0, 200));
ok('panel exposes the version/update row', /版本/.test(afterOpen) && /当前/.test(afterOpen) && /检查更新|检查中|检查失败/.test(afterOpen), afterOpen.slice(0, 200));

// ---- palette switch: follow-theme -> pure black ----
const findButton = (node, label) => {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  const nodeProps = node.props || {};
  if (node.type === 'button' && nodeProps.children === label) return node;
  return findButton(nodeProps.children, label);
};
const hudRow = (tree) => (tree.props?.children || []).find((node) => node && node.props && typeof node.props.onMouseEnter === 'function');
ok('panel exposes the palette switch', findButton(tree, '跟随主题') !== undefined);
const paletteButton = findButton(tree, '跟随主题');
paletteButton.props.onClick();
tree = render();
const blackRow = hudRow(tree);
ok('palette switch relabels itself to 纯黑', findButton(tree, '纯黑') !== undefined);
ok('palette switch persists the choice', store.get('dsh-usage-cost:color-mode') === 'black');
ok('black palette rewrites the row colour token', blackRow?.props.style?.['--dsw-alias-label-secondary'] === '#000000', JSON.stringify(blackRow?.props.style));
const backButton = findButton(tree, '纯黑');
backButton.props.onClick();
tree = render();
ok('palette switch returns to the theme', findButton(tree, '跟随主题') !== undefined && store.get('dsh-usage-cost:color-mode') === 'theme');
ok('theme palette leaves the tokens alone', hudRow(tree)?.props.style?.['--dsw-alias-label-secondary'] === undefined);

// ---- placement switch: header -> composer dock -> fixed corner pill ----
const mountSeat = (Component) => {
  states = [];
  occupant = Component;
  return render();
};
const positionButton = findButton(tree, '顶部');
ok('panel exposes the placement switch', positionButton !== undefined);
positionButton.props.onClick();
tree = render();
ok('header seat retires once the dock is chosen', tree === null);
ok('placement choice persists', store.get('dsh-usage-cost:position') === 'composer');
let dockTree = mountSeat(dockSeat.Component);
ok('dock seat renders the HUD', dockTree !== null && /会话/.test(textOf(dockTree)));
ok('dock placement stays in flow', dockTree?.props?.style?.position === undefined);
const dockRow = (dockTree.props?.children || []).find((node) => node && node.props && typeof node.props.onMouseEnter === 'function');
dockRow.props.onMouseEnter();
dockTree = render();
const overlayButton = findButton(dockTree, '输入框下');
ok('dock panel exposes the placement switch', overlayButton !== undefined);
overlayButton.props.onClick();
dockTree = render();
ok('overlay placement renders a fixed pill', dockTree?.props?.style?.position === 'fixed');
ok('overlay keeps the row content', /会话/.test(textOf(dockTree)));
ok('overlay placement persists', store.get('dsh-usage-cost:position') === 'overlay');
const backPosition = findButton(dockTree, '右下角');
ok('overlay panel exposes the next placement', backPosition !== undefined);
backPosition.props.onClick();
dockTree = render();
ok('third click cycles back to the top', store.get('dsh-usage-cost:position') === 'header' && dockTree === null);
const headerAgain = mountSeat(headerSeat.Component);
ok('header seat paints again after the cycle', headerAgain !== null && /会话/.test(textOf(headerAgain)));

// ---- draggable corner pill ----
store.set('dsh-usage-cost:position', 'overlay');
store.delete('dsh-usage-cost:spot');
let corner = mountSeat(dockSeat.Component);
ok('corner pill defaults to the bottom-right corner', corner?.props?.style?.right === '16px' && corner?.props?.style?.left === undefined);
ok('corner pill exposes a drag handler', typeof corner?.props?.onPointerDown === 'function');
ok('corner pill is tagged for the drag-region rule', corner?.props?.['data-uc-hud-pill'] === '');
corner.props.onPointerDown({ button: 0, clientX: 900, clientY: 820, target: { closest: () => null }, preventDefault() {} });
corner = render();
global.window.__fire('pointermove', { clientX: 920, clientY: 830 });
corner = render();
ok('drag moves the pill inside the window', corner?.props?.style?.left === '920px' && corner?.props?.style?.top === '80px', JSON.stringify(corner?.props?.style));
global.window.__fire('pointerup', {});
corner = render();
const savedSpot = JSON.parse(store.get('dsh-usage-cost:spot') || '{}');
ok('drag persists the position', savedSpot.x === 920 && savedSpot.y === 80, store.get('dsh-usage-cost:spot'));
store.set('dsh-usage-cost:spot', JSON.stringify({ x: 40, y: 50 }));
const restored = mountSeat(dockSeat.Component);
ok('saved position is restored on mount', restored?.props?.style?.left === '40px' && restored?.props?.style?.top === '50px');
store.set('dsh-usage-cost:spot', JSON.stringify({ x: 40, y: 4 }));
const pulledDown = mountSeat(dockSeat.Component);
ok('a pill parked in the window chrome is pulled below it', pulledDown?.props?.style?.top === '48px' && pulledDown?.props?.style?.left === '40px', JSON.stringify(pulledDown?.props?.style));
store.set('dsh-usage-cost:spot', 'not json');
const corrupt = mountSeat(dockSeat.Component);
ok('corrupt saved position falls back to the corner', corrupt?.props?.style?.right === '16px');
ok('corner pill paints the theme surface', String(corrupt?.props?.style?.backgroundColor).includes('--dsw-alias-bg-base'));

// ---- black palette on the corner pill: the text must not stay black on black ----
store.set('dsh-usage-cost:position', 'overlay');
store.set('dsh-usage-cost:color-mode', 'black');
const blackPill = mountSeat(dockSeat.Component);
const blackRowSpan = Array.isArray(blackPill?.props?.children?.props?.children) ? blackPill.props.children.props.children[0] : undefined;
ok('black palette keeps pill text light', blackRowSpan?.props?.style?.['--dsw-alias-label-secondary'] === '#ececec', JSON.stringify(blackRowSpan?.props?.style));
ok('black palette still paints the pill black', blackPill?.props?.style?.['--dsw-alias-bg-base'] === '#000000');
store.set('dsh-usage-cost:color-mode', 'theme');

// ---- per-state element visibility ----
store.set('dsh-usage-cost:position', 'header');
store.delete('dsh-usage-cost:fields');
const baseRow = mountSeat(headerSeat.Component);
const baseText = textOf(hudRow(baseRow));
ok('expanded shows the session pair', /会话/.test(baseText) && /估 ￥/.test(baseText), baseText);
ok('expanded shows balance and today', /余额/.test(baseText) && /今日/.test(baseText), baseText);
const findNode = (node, pred) => {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, pred);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== 'object' || !node.props) return undefined;
  if (pred(node)) return node;
  return findNode(node.props.children, pred);
};
const field = (state, key) => (node) => node.props['data-field'] === state + ':' + key;

// open the panel and its element editor
hudRow(baseRow).props.onMouseEnter();
tree = render();
findButton(tree, '编辑').props.onClick();
tree = render();
ok('element editor exposes both states', findNode(tree, field('expanded', 'today')) !== undefined && findNode(tree, field('collapsed', 'balance')) !== undefined);
ok('enabled-but-empty chips are marked', findNode(tree, field('expanded', 'today'))?.props?.style?.border.includes('dashed'), JSON.stringify(findNode(tree, field('expanded', 'today'))?.props?.style));

// hide 今日 in the expanded row, show 余额 in the folded one
findNode(tree, field('expanded', 'today')).props.onClick();
tree = render();
findNode(tree, field('collapsed', 'balance')).props.onClick();
tree = render();
const storedFields = JSON.parse(store.get('dsh-usage-cost:fields') || '{}');
ok('field switch persists per state', storedFields.expanded?.today === false && storedFields.collapsed?.balance === true, JSON.stringify(storedFields));
ok('hidden element leaves the expanded row', !/今日/.test(textOf(hudRow(tree))), textOf(hudRow(tree)));

// fold: the configured collapsed set must include balance now
findNode(tree, (node) => node.type === 'button' && node.props['aria-label'] === '折叠用量条').props.onClick();
tree = render();
const foldedText = textOf(tree);
ok('folded row keeps the session pair', /会话/.test(foldedText) && /估 ￥/.test(foldedText), foldedText);
ok('folded row honours the configured element', /余额/.test(foldedText), foldedText);

// ---- narrow header auto degradation (container queries) ----
const styleNode = findNode(headerAgain, (node) => node.type === 'style');
const styleText = typeof styleNode?.props?.children === 'string' ? styleNode.props.children : '';
ok('header row ships container-query rules', styleText.includes('@container') && styleText.includes('max-width: 920px') && styleText.includes('[data-uc-hud-field=today]'), styleText);
ok('hidden rule is scoped to the header seat', styleText.includes('[data-uc-hud-seat=header]'));
ok('row is tagged with its seat', hudRow(headerAgain)?.props?.['data-uc-hud-seat'] === 'header');
ok(
  'HUD boxes opt out of the window drag region',
  styleText.includes('[data-uc-hud-seat]{-webkit-app-region:no-drag}') && styleText.includes('[data-uc-hud-pill]{-webkit-app-region:no-drag}') && styleText.includes('[data-uc-hud-panel]{-webkit-app-region:no-drag}'),
  styleText
);
ok('each element is wrapped for the query', findNode(headerAgain, (node) => node.props?.['data-uc-hud-field'] === 'session') !== undefined);

// ---- every element inside a children array is keyed (React's list warning) ----
store.set('dsh-usage-cost:position', 'header');
store.set('dsh-usage-cost:color-mode', 'theme');
store.delete('dsh-usage-cost:fields');
store.delete('dsh-usage-cost:collapsed');
const keyTree = mountSeat(headerSeat.Component);
hudRow(keyTree).props.onMouseEnter();
let keyRender = render();
findButton(keyRender, '编辑').props.onClick();
keyRender = render();
const keyProblems = [];
const scan = (children) => {
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child === null || child === undefined || typeof child !== 'object') continue;
      if (Array.isArray(child)) {
        scan(child);
        continue;
      }
      if (!child.key) keyProblems.push({ type: String(child.type), keys: Object.keys(child.props || {}).slice(0, 8), text: JSON.stringify(child.props?.children)?.slice(0, 90) });
      scan(child.props?.children);
    }
    return;
  }
  if (children && typeof children === 'object' && children.props) scan(children.props.children);
};
scan(keyRender);
ok('every list child carries a key', keyProblems.length === 0, JSON.stringify(keyProblems));

// The Host serves every client plugin as one script and the page re-evaluates it
// whenever the revision changes. A top-level `const` would then throw
// "Identifier has already been declared" and take the whole HUD down with it.
{
  const vm = require('node:vm');
  const context = vm.createContext({ window: { __ModuleLoader__: { load() {} } } });
  let thrown;
  try {
    vm.runInContext(src, context);
    vm.runInContext(src, context);
  } catch (error) {
    thrown = error;
  }
  ok('the bundle survives being evaluated twice in one global scope', thrown === undefined, thrown && thrown.message);
}

console.log('\n%d passed, %d failed', pass, fail);
process.exit(fail === 0 ? 0 : 1);




