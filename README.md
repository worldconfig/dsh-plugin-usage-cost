# dsh-plugin-usage-cost

会话头部常驻 HUD：实时显示**本轮 / 本会话**的 token 消耗、**账户余额**、**这一轮真实花掉的钱**
（余额差值，不靠单价猜），以及**今日累计扣费**。

- 宿主半侧（`lib/index.js`）：抓取并解析 DeepSeek 官方价目表，用同源路由转发给页面
- 浏览器半侧（`lib/client.js`）：HUD、悬停浮层、价格刷新、峰谷判定、配色 / 位置 / 显示元素设置
- 自带测试：`npm test`（112 项断言，离线跑 fixture）

## 长什么样

会话标题栏右侧（「会话头部 · 工具区」；也可切到输入框下方或右下角，见下文「HUD 放哪儿」）：

```
本轮 3.0M · 估 ￥0.72    会话 11.4M · 估 ￥3.04    余额 ￥12.07 ↓￥0.42    今日 ￥0.83    ⟳    ● 运行中    ▴
```

| 段 | 含义 | 数据来源 |
|---|---|---|
| `本轮` | 当前这一轮自己的 token 数 | `tokenUsage` 投影的差量 |
| `本轮 · 估` | 这一轮的金额（估算） | 单价表，或实测均价 |
| `会话` | 整份会话日志的累计 | `tokenUsage` 投影（host 回放整份日志） |
| `会话 · 估` | 整个会话的金额（估算） | 同上 |
| `余额` | 充值 + 赠金合计 | `account.getBalance` |
| `↓` | 本轮真实扣费 | 余额差值 |
| `今日` | 今日累计真实扣费 | 本机观察到的余额下降累加（见下） |
| `● 运行中` | 会话正在跑 | `useSession(s => s.running)` |
| `⟳` | 重新抓取官网价目 | 宿主同源路由 |

**没有本轮基线时不显示 `本轮`**：页面在一轮中途打开时不会谎报 `本轮 0`，等下一次真正的轮次开始才起算。

刷新页面或切换座位时，会从 `localStorage["dsh-usage-cost:turn-base"]` 读回**上一实例记下的轮次起点**
（同一会话、运行中、10 分钟内），所以后台刷新不会丢掉本轮；会话空闲时写入的观察会标记为非运行，
绝不复用成下一轮的起点。

行尾是一个 20×20 的箭头图标按钮（14px 线性 chevron，悬停有底色）：箭头朝上表示可折叠，朝下表示可展开；
折叠状态记在 `localStorage["dsh-usage-cost:collapsed"]`，折叠时显示哪些元素由「显示」设置决定，
默认是**会话 token + 会话金额**这一对。

## 悬停浮层

悬停 HUD 弹出自绘浮层（不是系统 tooltip），五组信息：

- **会话**：完整模型版本名（`DeepSeek-V4.1-Flash-1017`）、模型 id、路由、推理等级、计价时段、会话 token
- **TOKEN 分项**：未缓存输入 / 缓存读取 / 缓存写入 / 输出，每行带当前单价（`336,957 × ￥2.00/M`）
- **金额**：本轮估价、会话估价、本次消耗（余额差值）、今日消耗（余额累计）、实测均价
- **账户**：余额、充值、赠金
- **价目**：来源、核对日期、偏差、未收录模型、刷新失败原因

浮层不透明、右对齐，**朝空间大的那一侧展开**（顶部座位、靠上的胶囊向下；输入框下、靠下的胶囊向上），
并按那一侧剩余空间限制高度、超出滚动；从 HUD 移入浮层不会关闭（140 ms 缓关）。

模型全名来自官网「模型版本」行（如 `模型版本 | DeepSeek-V4.1-Flash-1017 | DeepSeek-V4-Pro-0813`），
抓取成功后自动更新；未抓到时用内置副本兜底，因此 `deepseek-flash` 也能显示成 `DeepSeek-V4.1-Flash-1017`。
推理等级取 `modelSelection` 投影的 `reasoningEffort`，首字母大写显示（`High` / `Medium` / `Low`）。

## 配色：跟随主题 / 纯黑

浮层底部有一行「配色」，右侧按钮点一下就在两种模式间切换，选择记在
`localStorage["dsh-usage-cost:color-mode"]`（`theme` / `black`，默认 `theme`）：

| 模式 | 行文字 | 悬停浮层 / 右下角胶囊 |
|---|---|---|
| 跟随主题（默认） | 主题的 secondary / tertiary | 主题表面色（半透明菜单色叠在不透明底色上，带主题 tint） |
| 纯黑 | 浅色主题下纯黑 `#000`，深色主题下纯白 `#fff`；弱化项用同级透明度 | 不透明纯黑 `#000` + 中性浅灰文字，去掉主题 tint |

实现不需要复制样式：行容器和浮层容器各自重定义 `--dsw-alias-*` 变量（React inline style 支持
`--*` 键，CSS 变量向下继承），子元素原来的 `var(--dsw-...)` 就自动换成新值。深浅判定读
`ctx.get("theme").getTheme().active.colorScheme`；切换主题后下一次 HUD 重绘时生效。

> 右下角胶囊在纯黑模式下**跟着浮层那套走**（黑底 + 浅字），不能跟「行」那套：行文字为了在浅色页面上
> 可读会被刷成纯黑，而胶囊底色同时是纯黑，叠在一起就是一条看不出字的黑条。

## HUD 放哪儿：顶部 / 输入框下 / 右下角

浮层底部第二行「位置」点一下循环切换，选择记在 `localStorage["dsh-usage-cost:position"]`：

| 位置 | 坐在哪个 slot | 适合 |
|---|---|---|
| 顶部（默认） | `conversation.session.header.utilities` | 原行为，视线在标题栏 |
| 输入框下 | `conversation.composer.dock`（官方 usage 同一区） | 打字时不抬头，不遮挡内容 |
| 右下角 | 同一个 dock 实例渲染 `position: fixed` 胶囊 | 大屏余光可见；会浮在内容上 |

两个座位都注册，非当前座位 `return null`；切换时用模块内订阅把新位置广播给另一个实例（两个实例在
不同 slot 里，互相看不见 state）。dock 和右下角胶囊的浮层都**向上展开**，因为它们贴着屏幕底部。

胶囊可以**按住拖到窗口内任意位置**（光标变成抓手；按在按钮上不算拖动）：

- 拖动时在 `window` 上跟指针，指针移出胶囊也继续跟随，四周始终留 8px 边距；
- **顶部 48px 是窗口拖动区**：那里鼠标事件归操作系统（拖窗口），放进去的胶囊会“看得见但点不动”，
  所以胶囊最多拖到这条线以下；早先存进去的越界位置会在加载时自动拉回来；
- 松手才写一次 `localStorage["dsh-usage-cost:spot"]`（`{x, y}`），下次打开还原；
- 窗口尺寸变化时自动把胶囊夹回可视区；没拖过的默认位置仍然贴右下角（`right/bottom`），随窗口自适应；
- 存的值坏了（不是 JSON / 不是数字）就回退默认角落。

HUD 的三个盒子（行、胶囊、浮层）都显式声明了 `-webkit-app-region: no-drag`，即使落在窗口 chrome 的
拖动区域里也能收到点击和悬停——这是 Electron 里嵌在标题栏的可交互元素的通行做法。

> 局限：右下角是靠 CSS `position: fixed` 从会话区“逃”出来的。如果哪天 composer 的祖先元素加了
> `transform` / `filter`，fixed 会相对那个祖先定位；真出现错位就改成 body portal。

### 顶部挤满时自动降级

标题栏这一行是 `flex: none`（外壳的 `.headerUtilities` 也是），谁都不收缩：窗口/会话栏变窄时会先把
**标题**压没，再窄就会溢出到右侧 corner 菜单。所以顶部座位用 **CSS 容器查询**按可用宽度自动少显示几项
（容器就是外壳的 `.titleRow`，它自带 `container-type: inline-size`）：

| 容器宽度 | 自动隐藏 |
|---|---|
| < 920px | 今日 |
| < 860px | 本轮 |
| < 800px | ↓ |
| < 740px | 运行中 |
| < 680px | 余额 |

- 只减不增：你在「显示」里关掉的项不会因此被打开，手动开关永远优先；
- 只作用于 `data-uc-hud-seat="header"`，**输入框下 / 右下角不受影响**（它们不占标题栏）；
- 窗口变宽自动恢复，不需要重开；
- 规则写在一个组件内的 `<style>` 里，若站点 CSP 禁掉内联样式，规则失效但不会报错，只是退回“不降级”。

> 阈值是按当前行宽估的；如果觉得隐藏得太早/太晚，改 `AUTO_HIDE_CSS` 里那五个 `max-width` 即可。

## 展开 / 折叠各显示什么

浮层底部「显示 → 编辑」里有六枚开关，**展开**和**折叠**各一套，互相独立：

| 键 | 显示成 |
|---|---|
| 本轮 | `本轮 3.0M · 估 ￥0.72`（没有本轮基线时整段不出现） |
| 会话 | `会话 11.4M · 估 ￥3.04`（没有金额时只显示 token） |
| 余额 | `余额 ￥12.07`，或 `读取中` / `读取失败` |
| ↓ | 本轮真实扣费（只有大于 0 时出现） |
| 今日 | `今日 ￥0.83` |
| 运行中 | `● 运行中` |

- 左侧「展开」「折叠」是状态名，点 chip 切换显示/隐藏（实心 = 显示，空心 = 隐藏）；当前正显示的那一套标着「当前」；
- **虚线 + 半透明** = 已开启，但此刻没有数据可显示（本轮还没开始 / 还没有扣费 / 空闲时没有「运行中」），不是开关失灵；
- 默认：展开全开；折叠只开「会话」——所以折叠时也能看到会话 token 和会话金额；
- 选择存 `localStorage["dsh-usage-cost:fields"]`（`{expanded:{...}, collapsed:{...}}`），坏数据逐字段回退默认；
- 两个座位共用一份保存值：切回某个座位时会重读，另一个座位改过的设置不会丢失；
- ⟳ 刷新和折叠箭头是控件，不参与这套开关。

> 行太长被所在位置裁掉时，用这套开关删掉不需要的元素，比改 CSS 省事。

## 金额怎么算

按优先级：

1. **单价表**（内置官方价 + 可被官网抓取覆盖）—— 按桶分别计价：`Σ(token桶 × 单价)`
2. **实测均价**（兜底）—— 每轮结束用「余额差值 ÷ 本轮 token」学出 ￥/token，按模型存 `localStorage`
   （键 `dsh-usage-cost:rate-per-token`），按 2:1 指数平滑
3. 都没有 —— 不显示金额，只显示 token

> 单价表估算与实测均价偏差超过 35%（且会话 > 20 万 token）时，判定价目过期：会话金额后出现 `⚠`，
> **自动改用实测均价**，浮层里显示偏差百分比。

> **实测均价的可靠性**：它来自「账户余额差 ÷ 本会话 token」，而余额是**账户级**的——别的会话、子代理、
> 工作流或赠金变动都会混进这个差值，把实测单价抬高（看到 `偏差 -62%` 多半就是这种情况，不是价目表错了）。
> 所以实测均价与单价表差距超过 2 倍（或低于一半）时，插件判定样本被污染：**不参与计价、不显示 `⚠`**，
> 浮层里标成「样本异常（可能含其它会话消耗）」，并跳过这一轮的速率学习。只有落在 [0.5×, 2×] 内的实测值
> 才会触发“价目可能过期”的判断。

### 今日消耗

`今日` 不是估算，是**真实扣费**：每次采样到余额（挂载时、运行中每 30 秒、一轮结束 2 秒后）就把
「上次余额 − 本次余额」的正数部分累加进当天计数，存在 `localStorage["dsh-usage-cost:today"]`
（`{ date, spend, last }`）：

- **充值不冲抵**：余额上升只把比较基准抬到新余额，不会把当日消耗算小或算成负数；
- **跨日归零**：按**本地时区**的 `YYYY-MM-DD` 换日，新的一天第一次采样只当基准，不计费；
- **换座位不重复计**：采样前先重读 localStorage，以存储值为准（两个座位只有一个在采样）。

局限：只统计**本机、本插件运行期间**观察到的余额变化；关着应用时在别处花的钱不计入，清掉站点数据会归零。

## 只给官方模型计价

按 **provider** 判定，provider 以 `deepseek` 开头才算官方：

| 情形 | HUD | 浮层 |
|---|---|---|
| 官方且价目已收录 | 正常显示金额 | 「按单价表推算」 |
| 官方但价目没收录（新模型） | 显示 **`价目未收录`**，不给金额 | 「官网价目里没有 X，已自动尝试拉取」 |
| 第三方（`bailian`、`moonshotai-cn` …） | 不显示金额 | 「计价 —（只给官方 DeepSeek 路由计价）」 |

**新模型自动跟进**：首次在官方路由用到未收录模型 → 标 `价目未收录` + 自动拉一次官网价目
（同一路由只试一次，1 小时内不重复抓）；官网一旦收录，解析器会自动带上该列（它抓的是整张表），无需改代码。

## 单价（官方峰谷双价）

来源 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>，单位 **元 / 百万 token**：

| 桶 | `deepseek-flash`（V4.1-Flash-1017）空闲 | 高峰 | `deepseek-v4-pro`（V4-Pro-0813）空闲 | 高峰 |
|---|---|---|---|---|
| 输入·缓存命中 | 0.02 | 0.04 | 0.15 | 0.30 |
| 输入·缓存未命中 | 1 | 2 | 4.5 | 9.0 |
| 输出 | 4 | 8 | 13.5 | 27.0 |

**高峰** = 北京时间周一至周五 `09:00-12:00`、`14:00-18:00`（不含法定节假日），其余空闲；空闲价是高峰价的一半。
插件按 `Intl.DateTimeFormat` + `Asia/Shanghai` 实时判定，每分钟重算，跨边界自动切换。

`cacheWrite` 官方无单独定价，按「未命中输入」计。法定节假日需补进 `HOLIDAYS`（`YYYY-MM-DD`），否则节假日会按高峰算。

## ⟳ 按钮与自动抓价

点击后：

```
页面 fetch("/usage-cost-hud/prices")  →  宿主 Node fetch 官网  →  拍平 HTML 按锚点解析  →  JSON
```

解析锚点：`模型` / `价格` / `空闲时段` / `高峰时段` / `百万tokens输入（缓存命中|未命中）` / `百万tokens输出`，
不依赖 DOM 选择器或 class 名。

- 成功：`✓ 价目已更新 23:59 · 2 个模型`（5 秒），覆盖内置 `PRICES` 并写入 `localStorage["dsh-usage-cost:price-override"]`
- 失败：`✗ 抓取失败：<原因>`（9 秒）+ 常驻红色 `价目失败` + 按钮 `⟳!`，估算继续用内置常量
- 静默刷新：价目超过 7 天自动抓一次；新模型探针也静默，不打扰
- 宿主缓存：成功 10 分钟 / 失败 15 秒（失败不锁死按钮），并发请求合并为一次（single-flight），8 秒超时

> 为什么必须在宿主侧抓：`api-docs.deepseek.com` 不返回 `Access-Control-Allow-Origin`，实测 OPTIONS 预检
> **403**，浏览器 `fetch` 必被拦。

宿主生命周期写进 `$DSH_HOME\usage-cost-host-status.json`（宿主进程没拿到 `DSH_HOME` 时退回系统临时目录，
再不可写就退回包目录）：

```json
{ "stage": "fetch-ok", "route": "/usage-cost-hud/prices", "models": ["deepseek-flash", "deepseek-v4-pro"] }
```

`stage`：`apply` → `waiting-webserver` → `registered` → `fetch-ok` / `fetch-failed`。

## 生效方式

| 改动 | 生效方式 |
|---|---|
| 只改 `lib/client.js` | 刷新页面（正式版窗口没有「刷新页面」菜单，在 F12 开发者工具里按 Ctrl+R） |
| 改了 `lib/index.js`（宿主） | **完全退出应用再打开**，刷新页面不会重载宿主插件 |

## 安装与卸载

这个包同时是**插件**和**bundle**：`package.json` 里声明 `dsh.bundle.patch`，由自带的
`cordis.patch.yml` 插入一行 `usage-cost-hud`：

```yaml
- insert:
    - id: usage-cost-hud
      name: dsh-plugin-usage-cost
```

安装用 Harness 的插件管理（`plugin_manager` 的 `install_bundle`，或设置 → 插件里从目录安装），
目标就是本目录。它做三件事：

1. `profiles\desktop\package.json` 的 `dependencies` 加 `"dsh-plugin-usage-cost": "link:E:/DSH/dsh-plugin-usage-cost"`
2. 同一文件的 `dsh.profile.bundles` 追加 `dsh-plugin-usage-cost`
3. 由包内 `cordis.patch.yml` 插入上面的 Loader 行

装好即生效（HMR），**不需要重启**；改了宿主代码才要完全退出重开。

卸载：用 `remove_bundle`（或设置 → 插件里禁用），它会同时清掉依赖和 bundle 选择。

### 从 GitHub 安装（发布版）

仓库 <https://github.com/worldconfig/dsh-plugin-usage-cost>，最新发布标签 `v1.2.6`。

在 Harness 里用 **git 规格**安装（不需要 npm 发布）：

```text
plugin_manager install_bundle   target: github:worldconfig/dsh-plugin-usage-cost#v1.2.6
```

或者用 CLI（需要先完全退出应用）：

```bash
dsh plugin --profile desktop add github:worldconfig/dsh-plugin-usage-cost#v1.2.6
```

包是纯 JS、没有 `prepare`/构建脚本，pnpm 从 git 拉下来即可直接加载；装完刷新页面。
如果同一 profile 里已经有指向本地目录的 `link:` 依赖，Windows 无法在应用运行时替换那个联接，
需要先退出应用、删掉 `node_modules\dsh-plugin-usage-cost` 联接，再装 GitHub 版本。

### 更新

插件**不会自动更新**：装的时候用的是哪个标签，就一直是哪个版本。要升级，
把上面的安装命令**再执行一次**、把标签换成新版本即可（例如 `#v1.2.6`）：

```text
plugin_manager install_bundle   target: github:worldconfig/dsh-plugin-usage-cost#v1.2.6
```

- 不需要重装 DSH，也不需要重下整个应用；仓库只有约 100 KB，pnpm 只拉新标签对应的差异；
- 装完刷新页面即可生效，宿主半侧改动才需要完全退出重开；
- 想始终跟最新代码，可以把标签换成 `#main`，但每次更新仍需重新执行一次安装（DSH 没有插件自动更新）；
- 生产使用建议钉具体标签，避免 `main` 上的未发布改动。

> ⚠️ 不要在 `profiles\desktop\cordis.patch.yml` 里手写这条 `insert`。
> 桌面版是打包运行时，裸包名只查安装侧的模块解析表；手写的行不在表里，
> 装载器只会静默跳过（表现为「配置合法、`apply` 从不执行」）。
> 该 yml 里目录会自己留 `.bak-*` 备份。

## 测试

```bash
npm test    # 112 项断言
```

| 套件 | 覆盖 |
|---|---|
| `test/host.test.mjs` | 真实页面解析、锚点缺失、列改名、路由注册、缓存命中、失败短缓存重试、超时文案、single-flight |
| `test/client-render.test.cjs` | 用假 React 跑真实渲染路径：两个座位注册、切换 / 拖拽 / 回落、配色与黑底可读、展开/折叠元素开关、容器查询降级、列表 key 审计、浮层五组内容、千分位、模型 / 路由 |
| `test/client-behaviour.test.cjs` | 轮次边界差量、第三方不计价、官方未收录告警、余额注入、今日消耗累计与充值重置基准 |

## 已知限制

- `CLIENT_VERSION` 写死 `0.2.1-rc.2`（取自 app.asar 账号面板内联版本）；**DSH 升级后若余额变 `读取失败`，先改这一行**
- 金额是估算：token 精确、单价来自官方表或实测均价；账单仍以 DeepSeek 为准
- `↓` 只覆盖插件运行期间观察到的扣费，无法回溯历史
- `今日` 同理：只累加本机运行期间看到的余额下降，关闭应用时在别处花的钱不计入；清站点数据会归零；充值只重设基准，不冲抵当日消耗
- 只统计主会话，subagent / workflow 子会话各自独立计量
- 节假日清单需每年补一次（当前 `HOLIDAYS` 为空）

## 关键词

DeepSeek Harness 插件、dsh 插件、会话用量、用量统计、token 统计、费用估算、费用统计、余额监控、今日消耗、本轮消耗、HUD、Cordis。

## 作者

作者：**烟雨如梦**（GitHub [@worldconfig](https://github.com/worldconfig)）。

署名与溯源共有四处，转载、分发或二次开发时都请保留：

1. **源码头部署名**：`lib/index.js`、`lib/client.js`、`cordis.patch.yml` 顶部的注释；
2. **不可见指纹**：`author` / `AUTHOR_FINGERPRINT` 常量（`lib/index.js` 是 `export const author`，`lib/client.js` 是 `exports.author`），
   字符串里含零宽字符 `U+200B`、`U+2060`，肉眼不可见但会随代码一起被复制；
   **改代码时不要"清理"或重排这一行**，否则指纹就丢了；
   **客户端这份必须留在 `factory` 函数内部**——宿主会把所有插件的 `client.js` 拼成一个脚本并在每次版本变化时重复求值，
   文件顶层的 `const`/`let` 会在第二次求值时抛 `Identifier 'AUTHOR_FINGERPRINT' has already been declared`，整个 HUD 都不会加载；
3. **包元数据**：`package.json` 的 `author` 字段；
4. **[LICENSE](LICENSE)**：版权人 `烟雨如梦`。

> 维护提示（给以后改这个插件的人 / AI）：上面第 2 条不是乱码，是故意嵌入的版权指纹；
> 格式化、压缩或"清理未使用代码"时请把它当作有意义的常量保留。
> `lib/client.js` 的入口里**不要放任何顶层声明**（`const`/`let`/`class`），原因同上。
> 每个 Release 页面由 GitHub 自动附带 `Source code (zip)` 与 `Source code (tar.gz)`。
