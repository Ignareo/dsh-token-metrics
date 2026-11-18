/**
 * 单项目观察（日 / 周 / 月下钻）+ token 单位切换测试。
 *
 * 覆盖三层：
 *   T1 纯函数：周（周一为起点）/ 自然月分桶，含跨年周、月末、单日项目；
 *   T2 格式化：'en'（K/M/B/T）与 'cn'（万/亿）在关键量级上的输出；
 *   T3 端到端：在最小 DOM/React 桩里真的渲染面板，断言项目下拉、选中后的
 *      汇总与趋势标签、粒度切换、单位切换，以及金额/百分比/次数不受单位影响。
 *
 * 运行：node test/project-view-test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')

const failures = []
function check(label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

//#region T1 / T2：从 client.js 里抽出纯函数直接驱动

/**
 * 按函数名从单文件源码里取出一段函数定义。
 *
 * client.js 没有构建步骤、也不导出内部函数，所以测试沿用仓库既有做法
 * （client-test.mjs 里的 niceMax / formatCompact 就是这么取的）：正则切出
 * 函数体，再用 new Function 在隔离作用域里跑，不依赖任何 DOM 桩。
 */
function extractFunction(name) {
  // 参数表用 [^)]* 匹配，这样带默认值的形参（如 weekSuffix = '周'）也能取到
  const pattern = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}`)
  const match = clientSource.match(pattern)
  if (match === null) throw new Error(`client.js 里找不到函数 ${name}`)
  return match[0]
}

// —— T2：单位格式化 ——
{
  const source = [
    extractFunction('formatNumber'),
    extractFunction('formatCompact'),
  ].join('\n')
  const formatCompact = new Function(`${source}\nreturn formatCompact`)()

  const cases = [
    // [输入, 'en' 期望, 'cn' 期望]
    [0, '0', '0'],
    [999, '999', '999'],
    [1234, '1,234', '1,234'],
    [1.2e4, '12K', '1.2万'],
    [3.2e7, '32M', '3200万'],
    [1.5e9, '1.5B', '15亿'],
    [5e12, '5T', '50000亿'],
  ]
  for (const [value, en, cn] of cases) {
    check(`formatCompact(${value}) 默认 'en'`, formatCompact(value), en)
    check(`formatCompact(${value}, 'en')`, formatCompact(value, 'en'), en)
    check(`formatCompact(${value}, 'cn')`, formatCompact(value, 'cn'), cn)
  }
  // 非法值不能吐 NaN / undefined（空态与异常数据都会走到这里）
  check('formatCompact(undefined)', formatCompact(undefined), '0')
  check("formatCompact(NaN)", formatCompact(NaN), '0')
  check("formatCompact('x')", formatCompact('x'), '0')
}

// —— T1：日桶 -> 周 / 月 分桶 ——
{
  const source = [
    extractFunction('emptyTokenCounters'),
    extractFunction('mondayOf'),
    extractFunction('bucketDailyCounters'),
  ].join('\n')
  const bucketDailyCounters = new Function(`${source}\nreturn bucketDailyCounters`)()

  const counters = (total) => ({
    calls: 1, inputTokens: total, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: total,
  })

  // 跨年周：2026-12-28（周一）所在那一周跨到 2027-01-03，必须整周落在同一个桶
  const crossYear = [
    ['2026-12-28', counters(100)],
    ['2026-12-31', counters(200)],
    ['2027-01-01', counters(300)],
    ['2027-01-03', counters(400)],
    ['2027-01-04', counters(500)],
  ]
  const weeks = bucketDailyCounters(crossYear, 'week', '周')
  check('跨年周：桶数', weeks.length, 2)
  check('跨年周：周一键', weeks[0].key, '2026-12-28')
  check('跨年周：标签', weeks[0].label, '12-28 周')
  check('跨年周：合计', weeks[0].counters.totalTokens, 1000)
  check('跨年周：下一周另起', weeks[1].key, '2027-01-04')

  // 自然月：跨月的天不能并到一个桶里；月末最后一天必须归本月
  const monthly = bucketDailyCounters([
    ['2026-10-31', counters(10)],
    ['2026-11-01', counters(20)],
    ['2026-11-30', counters(30)],
    ['2026-12-01', counters(40)],
  ], 'month', '周')
  check('自然月：桶数', monthly.length, 3)
  check('自然月：10 月', monthly[0].key, '2026-10')
  check('自然月：10 月合计', monthly[0].counters.totalTokens, 10)
  check('自然月：11 月', monthly[1].key, '2026-11')
  check('自然月：11 月合计', monthly[1].counters.totalTokens, 50)
  check('自然月：12 月', monthly[2].key, '2026-12')

  // 单日项目：日粒度原样一天；周/月各自只有一个桶，不出现空桶
  const single = [['2026-11-18', counters(7)]]
  check('单日：日桶', bucketDailyCounters(single, 'day', '周').length, 1)
  check('单日：日标签', bucketDailyCounters(single, 'day', '周')[0].label, '2026-11-18')
  check('单日：周桶', bucketDailyCounters(single, 'week', '周')[0].key, '2026-11-16')
  check('单日：月桶', bucketDailyCounters(single, 'month', '周')[0].key, '2026-11')

  // 乱序输入必须排好序（byDayFacets 的键顺序不保证）
  const shuffled = bucketDailyCounters([
    ['2026-11-24', counters(1)],
    ['2026-11-16', counters(1)],
    ['2026-11-17', counters(1)],
  ], 'week', '周')
  check('周桶按周一升序', shuffled.map((bucket) => bucket.key).join(','), '2026-11-16,2026-11-23')

  // 空输入 / 非法键：返回空数组，不产生 NaN 桶
  check('空输入', bucketDailyCounters([], 'week', '周').length, 0)
  check('非法日期被跳过', bucketDailyCounters([['not-a-day', counters(5)]], 'day', '周').length, 0)
  check('缺 counters 被跳过', bucketDailyCounters([['2026-11-16', null]], 'day', '周').length, 0)
  // 英文界面用 wk 后缀，标签形态仍以周一日期开头
  check('英文周标签', bucketDailyCounters(single, 'week', 'wk')[0].label, '11-16 wk')
}

//#endregion

//#region T3：端到端渲染（最小 DOM / React 桩）

const insertedStyles = []
const documentStub = {
  hidden: false,
  head: {
    appendChild(tag) { insertedStyles.push(tag) },
  },
  querySelector() { return null },
  createElement(tagName) {
    return {
      tagName,
      attributes: {},
      textContent: '',
      setAttribute(name, value) { this.attributes[name] = value },
      remove() {
        const index = insertedStyles.indexOf(this)
        if (index !== -1) insertedStyles.splice(index, 1)
      },
    }
  },
  addEventListener() {},
  removeEventListener() {},
}

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

const hookState = []
let hookIndex = 0
function resetHooks() {
  hookIndex = 0
}
const React = {
  createElement,
  useState(initial) {
    const index = hookIndex++
    if (!(index in hookState)) {
      hookState[index] = typeof initial === 'function' ? initial() : initial
    }
    const set = (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next
    }
    return [hookState[index], set]
  },
  useEffect(effect) {
    // 立即执行：本测试只关心首帧之后的结果，不模拟清理时序。
    const cleanup = effect()
    if (typeof cleanup === 'function') pendingCleanups.push(cleanup)
  },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useRef(value) {
    const index = hookIndex++
    if (!(index in hookState)) hookState[index] = { current: value }
    return hookState[index]
  },
  Fragment: Symbol('Fragment'),
}
const pendingCleanups = []

let loaded
globalThis.window = {
  navigator: { language: 'zh-CN' },
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, factory }
    },
  },
}
globalThis.document = documentStub

// —— 夹具：跨月、跨周（含跨年周的等价形态）的项目逐日数据 ——
const COUNTERS = (totalTokens, calls = 1, inputTokens = 0, cacheReadTokens = 0) => ({
  calls,
  inputTokens,
  outputTokens: 0,
  cacheReadTokens,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens,
})

/**
 * 项目 /work/alpha 的逐日桶。
 *
 * 日期刻意选在 2026-11-16（周一）、2026-11-30（周一）等周起点上，
 * 用来断言「周以周一为起点」——2026-12-01 是周二，必须归到 11-30 那一周。
 */
const ALPHA_DAYS = {
  '2026-11-16': 1_000_000,
  '2026-11-17': 1_000_000,
  '2026-11-23': 2_000_000,
  '2026-11-24': 2_000_000,
  '2026-12-01': 3_000_000,
  '2026-12-14': 4_000_000,
  '2026-12-15': 4_000_000,
  '2026-12-16': 4_000_000,
}
const ALPHA_TOTAL = Object.values(ALPHA_DAYS).reduce((sum, value) => sum + value, 0)

const byDayFacets = {}
for (const [day, tokens] of Object.entries(ALPHA_DAYS)) {
  byDayFacets[day] = {
    project: { '/work/alpha': COUNTERS(tokens, 2, tokens / 2, tokens / 2) },
    provider: {},
    origin: {},
    account: {},
  }
}
// 单日项目：日粒度只有一个点，周/月也只有一个桶
byDayFacets['2026-12-15'].project['/work/delta'] = COUNTERS(500_000)

const SUMMARY = {
  generatedAt: Date.now(),
  today: '2026-12-20',
  totals: {
    // cacheHitRate 由 Host 算好：指标卡直接用这个值（与真实快照一致）
    all: { ...COUNTERS(1_500_000_000, 23_456, 40_000_000, 1_450_000_000), cacheHitRate: 0.42 },
    today: COUNTERS(1_500_000_000, 23_456, 40_000_000, 1_450_000_000),
    week: COUNTERS(1_500_000_000, 23_456, 40_000_000, 1_450_000_000),
  },
  byDay: Object.fromEntries(Object.entries(ALPHA_DAYS).map(
    ([day, tokens]) => [day, COUNTERS(tokens * 2, 2, tokens, tokens)],
  )),
  byDayFacets,
  byProject: {
    // alpha：有完整逐日数据
    '/work/alpha': COUNTERS(ALPHA_TOTAL, 16, ALPHA_TOTAL / 2, ALPHA_TOTAL / 2),
    // beta：全时段有量，但逐日被 retention 裁掉了（空态用例）
    '/work/beta': COUNTERS(9_000_000),
    // delta：只有一天
    '/work/delta': COUNTERS(500_000),
  },
  byModel: {},
  // 模型下拉的选项来自 byModelName；项目视图不读它（只用于验证提示文案）
  byModelName: { 'deepseek-v4.1-flash': COUNTERS(1_500_000_000, 23_456, 40_000_000, 1_450_000_000) },
  byModelFacets: { 'deepseek-v4.1-flash': { provider: {}, project: {}, origin: {}, account: {}, day: {} } },
  byModelDay: {},
  byDayModel: {},
  byDayModelName: {},
  byProvider: {},
  byOrigin: {},
  accounts: {},
  bySession: {},
  modelTrend: { days: [], series: [] },
  performance: { total: { ttftMs: null, tps: null, samples: 0 }, byModel: {} },
  // 项目成本没有单独记账：按「当天 token 占比」折算当天成本。
  // 夹具里 alpha 每天占当天总量的一半，所以 12-14/12-15 各 2 美元 -> 项目 2.00 美元。
  cost: {
    totalUsd: 12.34,
    byDay: { '2026-12-14': 2, '2026-12-15': 2 },
    byModel: {}, unpriced: [], fx: { usdCny: 7.2 },
  },
  config: {
    showSessions: false,
    trackFailedAttempts: false,
    snapshotCacheMs: 3000,
    retentionDays: 400,
    maxTrendSeries: 6,
    budget: {},
  },
  failedAttempts: null,
  currentAccount: null,
  integrity: { consistent: true },
  repositoryUrl: 'https://github.com/example/dsh-token-metrics',
  storePath: '/tmp/usage.json',
}

globalThis.fetch = async (url) => {
  if (String(url).includes('/api/dsh-token-metrics/balance')) {
    return { ok: true, status: 200, async json() { return { sites: [], discovered: [] } } }
  }
  if (String(url).includes('/api/dsh-token-metrics/quota/summary')) {
    return { ok: true, status: 200, async json() { return { ok: true, windows: [] } } }
  }
  return {
    ok: true,
    status: 200,
    async json() { return SUMMARY },
  }
}

const { runInNewContext } = await import('node:vm')
runInNewContext(clientSource, {
  window: globalThis.window,
  document: documentStub,
  fetch: globalThis.fetch,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  Number,
  String,
  Object,
  Array,
  Error,
  URL,
  Symbol,
})

if (loaded === undefined) {
  console.error('✗ client.js 没有调用 __ModuleLoader__.load')
  process.exit(1)
}

const moduleStub = { exports: {} }
const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error(`意外的模块依赖：${name}`)
}
const exportsValue = loaded.factory(requireStub)

const registrations = []
const localeRegistrations = []
let currentLocaleId = 'zh'
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  slots: {
    inject(ownerKey, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register(ns, dicts) {
      localeRegistrations.push({ ns, dicts })
      return () => {}
    },
    bind() {
      return (key) => {
        const dicts = localeRegistrations[0]?.dicts ?? {}
        return dicts[currentLocaleId]?.[key] ?? dicts.zh?.[key] ?? key
      }
    },
    getSnapshot() { return { active: currentLocaleId, locales: [], revision: 0 } },
    subscribe() { return () => {} },
  },
}

exportsValue.apply(ctx)
const panel = registrations.find((entry) => entry.options.name === 'main')
if (panel === undefined) {
  console.error('✗ 没有注册 main 面板')
  process.exit(1)
}
const panelInject = panel.options.inject()
const t = panelInject.t

function walkTree(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit)
    return
  }
  if (typeof node !== 'object') {
    visit(node)
    return
  }
  visit(node)
  if (typeof node.type === 'function') {
    try {
      walkTree(node.type(node.props ?? {}), visit)
    } catch (error) {
      failures.push(`组件渲染抛错 ${node.type?.name}: ${error?.message ?? error}`)
    }
    return
  }
  walkTree(node.children, visit)
}

function textsOf(node) {
  const out = []
  walkTree(node, (item) => {
    if (typeof item === 'string') out.push(item)
    if (typeof item.props?.className === 'string') out.push(item.props.className)
    if (typeof item.props?.title === 'string') out.push(item.props.title)
  })
  return out.join(' ')
}

/** 渲染一次面板（重置 hook 索引，状态仍跨渲染保留）。 */
function render() {
  resetHooks()
  return panel.component({ t, locale: panelInject.locale })
}

/**
 * 从零开始渲染（清空全部 hook 状态）。
 *
 * 首帧一定是 loading：数据来自 fetch，桩里的 setState 不会自动安排重渲染，
 * 所以必须像 client-test 那样「渲染 -> 等 fetch -> 再渲染一次」。
 */
async function renderFresh() {
  hookState.length = 0
  pendingCleanups.length = 0
  resetHooks()
  panel.component({ t, locale: panelInject.locale })
  await new Promise((resolve) => setTimeout(resolve, 50))
  resetHooks()
  return panel.component({ t, locale: panelInject.locale })
}

/** 按 className 找第一个节点。 */
function findByClass(tree, className) {
  let found
  walkTree(tree, (node) => {
    if (node?.props?.className === className) found = found ?? node
  })
  return found
}

/** 找项目下拉容器（与模型下拉的 className 不同，才好在测试里分开）。 */
function projectDropdownOf(tree) {
  let found
  walkTree(tree, (node) => {
    if (node?.props?.className === 'tu-dropdown tu-dropdown-project') found = node
  })
  return found
}

/** 点开项目下拉并选中某个 cwd（走真实的 onClick 链路）。 */
function selectProject(cwd) {
  // 打开下拉
  let tree = render()
  const dropdown = projectDropdownOf(tree)
  let btn
  walkTree(dropdown, (node) => {
    if (node?.props?.className === 'tu-dropbtn') btn = node
  })
  check('项目下拉有按钮', btn !== undefined, true)
  btn?.props?.onClick?.()
  // 菜单里的选项按 title（完整 cwd）定位
  tree = render()
  let target
  walkTree(projectDropdownOf(tree), (node) => {
    if (node?.props?.className === 'tu-dropitem' && node.props?.title === cwd) target = node
  })
  check(`项目下拉里有 ${cwd}`, target !== undefined, true)
  target?.props?.onClick?.()
  return render()
}

/** 点项目观察区里的粒度按钮（日/周/月）。 */
function pickGranularity(label) {
  const tree = render()
  let projectSection
  walkTree(tree, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-project')) {
      projectSection = projectSection ?? node
    }
  })
  let clicked = false
  walkTree(projectSection, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((child) => child === label)) {
      node.props?.onClick?.()
      clicked = true
    }
  })
  check(`项目观察里有「${label}」粒度按钮`, clicked, true)
  return render()
}

/** 项目观察区里的指标卡数值（只取 .tu-card-value 的文字）。 */
function projectCardValues(tree) {
  let section
  walkTree(tree, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-section tu-project')) {
      section = section ?? node
    }
  })
  const values = []
  if (section === undefined) return values
  walkTree(section, (node) => {
    if (node?.props?.className === 'tu-card-value') {
      for (const child of node.children ?? []) if (typeof child === 'string') values.push(child)
    }
  })
  return values
}

/** 项目观察区的渲染文本。 */
function projectText(tree) {
  let section
  walkTree(tree, (node) => {
    if (typeof node?.props?.className === 'string' && node.props.className.includes('tu-section tu-project')) {
      section = section ?? node
    }
  })
  return section === undefined ? '' : textsOf(section)
}

// 首次渲染：等 fetch 落地后重渲染（模拟 setState 触发的重渲染）
render()
await new Promise((resolve) => setTimeout(resolve, 200))

// —— T3-1：不选项目时没有项目观察区，默认单位是 B ——
{
  const tree = await renderFresh()
  check('默认没有项目观察区', projectText(tree), '')
  const flat = textsOf(tree)
  check('总 Token 卡片 label 带默认单位', flat.includes('总量 · B'), true)
  check('默认单位下显示 1.5B', flat.includes('1.5B'), true)
}

// —— T3-2：项目下拉存在，选中 alpha 后出现路径与汇总数字 ——
{
  const tree = selectProject('/work/alpha')
  const flat = projectText(tree)
  check('出现项目观察区', flat.includes('项目观察'), true)
  check('显示项目短路径', flat.includes('alpha'), true)
  check('显示项目全路径', flat.includes('/work/alpha'), true)
  // 汇总：总 token 21M、调用次数 16、成本（估算）、命中率 50%
  check('项目总 token（默认单位）', flat.includes('21M'), true)
  const values = projectCardValues(tree)
  check('项目调用次数精确值', values.includes('16'), true)
  check('项目命中率精确值', values.includes('50%'), true)
  // 成本卡片：按当天 token 占比折算的估算值（4 美元的一半 = $2.00）
  check('项目成本按占比折算', values.includes('$2.00'), true)
  // 日粒度：x 轴是完整日期（MM-DD 不是日粒度的形态）
  check('日粒度 x 轴为完整日期', flat.includes('2026-11-16'), true)
  check('日粒度不出现周标签', flat.includes('11-16 周'), false)
  // 日粒度最大一天 4M -> y 轴刻度 5M（可用作「没被聚合成周/月」的旁证）
  check('日粒度 y 轴按单日量级', flat.includes('5M'), true)
}

// —— T3-3：切到「周」：x 轴变成「周一日期 + 周」 ——
{
  const tree = pickGranularity('周')
  const flat = projectText(tree)
  check('周粒度 x 轴为周一日期', flat.includes('11-16 周'), true)
  check('周二归属于前一周一（11-30）', flat.includes('11-30 周'), true)
  check('周粒度不再出现完整日期标签', flat.includes('2026-11-16'), false)
  // 四个自然周各一个点：11-16 / 11-23 / 11-30 / 12-14。
  // 12-01 是周二，必须归到 11-30 那一周 —— 这是「周以周一为起点」的行为断言。
  for (const label of ['11-16 周', '11-23 周', '11-30 周', '12-14 周']) {
    check(`周桶 ${label}`, flat.includes(label), true)
  }
  // 周合计 12M（12-14 那周 3 天各 4M）：y 轴刻度随聚合量级抬到 20M；
  // 日粒度最大只有 4M（刻度 5M），两者不同即证明聚合生效。
  check('周聚合后 y 轴量级抬升', flat.includes('20M'), true)
}

// —— T3-4：切到「月」：x 轴变成 YYYY-MM ——
{
  const tree = pickGranularity('月')
  const flat = projectText(tree)
  check('月粒度 x 轴为 YYYY-MM', flat.includes('2026-11') && flat.includes('2026-12'), true)
  check('月粒度不出现周标签', flat.includes('11-16 周') || flat.includes('12-14 周'), false)
}

// —— T3-5：单位切换：点总 Token 卡后 B -> 亿，再点回 B ——
{
  let tree = render()
  const flatBefore = textsOf(tree)
  check('切换前是 1.5B', flatBefore.includes('1.5B'), true)
  const costBefore = (flatBefore.match(/\$\d+\.\d+/g) ?? []).join(',')
  const callsBefore = flatBefore.includes('23.5K')
  check('切换前调用次数按 K 显示', callsBefore, true)
  check('切换前命中率是百分比', flatBefore.includes('42%'), true)

  let card
  walkTree(tree, (node) => {
    if (node?.props?.className === 'tu-card tu-card-toggle') card = card ?? node
  })
  check('总 Token 卡可点（role=button）', card?.props?.role, 'button')
  check('总 Token 卡可聚焦', card?.props?.tabIndex, 0)
  check('总 Token 卡有 title 提示', typeof card?.props?.title, 'string')
  card?.props?.onClick?.()

  tree = render()
  const flatAfter = textsOf(tree)
  check('切换后同一数值变亿', flatAfter.includes('15亿'), true)
  check('切换后 label 显示亿', flatAfter.includes('总量 · 亿'), true)
  check('切换后不再显示 1.5B', flatAfter.includes('1.5B'), false)
  // 反例：金额 / 百分比 / 调用次数不能跟着变
  check('切换后金额不变', (flatAfter.match(/\$\d+\.\d+/g) ?? []).join(','), costBefore)
  check('切换后调用次数不变', flatAfter.includes('23.5K'), true)
  check('切换后命中率不变', flatAfter.includes('42%'), true)

  // 项目观察区的 token 也跟着单位变（21M -> 2100 万）
  const projectFlat = projectText(tree)
  check('项目区跟随单位（2100万）', projectFlat.includes('2100万'), true)
  check('项目区不再显示 21M', projectFlat.includes('21M'), false)

  // 再点一次回到 B
  let again
  walkTree(tree, (node) => {
    if (node?.props?.className === 'tu-card tu-card-toggle') again = again ?? node
  })
  again?.props?.onClick?.()
  const flatBack = textsOf(render())
  check('再点回 B', flatBack.includes('1.5B'), true)
  check('再点回 B 后 label 复位', flatBack.includes('总量 · B'), true)
  check('再点回 B 后金额仍不变', (flatBack.match(/\$\d+\.\d+/g) ?? []).join(','), costBefore)

  // 键盘可达：Enter 与 Space 都能触发切换
  let keyboardCard
  walkTree(render(), (node) => {
    if (node?.props?.className === 'tu-card tu-card-toggle') keyboardCard = keyboardCard ?? node
  })
  let prevented = false
  keyboardCard?.props?.onKeyDown?.({ key: 'Enter', preventDefault: () => { prevented = true } })
  check('Enter 触发切换', prevented, true)
  const afterEnter = textsOf(render())
  check('Enter 后变成亿', afterEnter.includes('15亿'), true)
  keyboardCard?.props?.onKeyDown?.({ key: ' ', preventDefault: () => { prevented = true } })
  check('Space 触发切换（回到 B）', textsOf(render()).includes('1.5B'), true)
}

// —— T3-5b：模型筛选与项目视图的关系（项目视图是全模型口径）——
{
  let tree = render()
  let modelDropdown
  walkTree(tree, (node) => {
    if (node?.props?.className === 'tu-dropdown') modelDropdown = modelDropdown ?? node
  })
  let btn
  walkTree(modelDropdown, (node) => { if (node?.props?.className === 'tu-dropbtn') btn = node })
  btn?.props?.onClick?.()
  tree = render()
  let modelItem
  walkTree(tree, (node) => {
    if (node?.props?.className === 'tu-dropitem'
      && textsOf(node).includes('deepseek-v4.1-flash')) modelItem = modelItem ?? node
  })
  check('模型下拉可选模型', modelItem !== undefined, true)
  modelItem?.props?.onClick?.()

  // alpha 在 T3-2 已经选中、之后没有取消（再点同一项会取消选择，
  // 所以这里不再点一次，直接看当前渲染）
  const flat = projectText(render())
  check('模型筛选后项目观察区仍在', flat.includes('项目观察'), true)
  check('有模型筛选时提示全模型口径', flat.includes('项目视图为全模型口径'), true)
  // 数据也没被模型筛选裁掉（仍是全模型口径的 21M）
  check('提示时项目数据仍为全模型口径', flat.includes('21M'), true)

  // 清掉模型筛选：后续用例依赖「未筛选」状态。
  // 注意菜单在勾选后仍然开着，这里不能再点按钮（那会把它收起）。
  const clear = render()
  let allModelItem
  walkTree(clear, (node) => {
    if (node?.props?.className === 'tu-dropitem' && textsOf(node).includes('全部模型')) {
      allModelItem = allModelItem ?? node
    }
  })
  allModelItem?.props?.onClick?.()
  check('清空模型筛选后提示消失', projectText(render()).includes('项目视图为全模型口径'), false)
}

// —— T3-6：空态 —— 逐日被 retention 裁掉 / 只有一天 / 不出现 NaN ——
{
  // beta 在 byProject 里有量，但 byDayFacets 里没有它的逐日数据
  const tree = selectProject('/work/beta')
  const flat = projectText(tree)
  check('裁掉逐日时给空态文案', flat.includes('该项目没有逐日明细'), true)
  check('空态仍显示全时段合计', flat.includes('全时段合计'), true)
  check('空态保留位天数说明', flat.includes('400'), true)
  const all = textsOf(tree)
  check('空态没有 NaN', /NaN/.test(all), false)
  check('空态没有 undefined', /undefined/.test(all), false)
  check('空态没有 Infinity', /Infinity/.test(all), false)

  // delta 只有一天：明确说明画不出趋势，而不是只给一句泛泛的「数据不足」
  const single = selectProject('/work/delta')
  const singleFlat = projectText(single)
  check('单日项目给出说明', singleFlat.includes('只有 1 个数据点'), true)
  check('单日项目仍显示汇总', singleFlat.includes('500K'), true)

  // 切回「全部项目」：项目观察区消失
  let tree2 = render()
  const dropdown = projectDropdownOf(tree2)
  let btn
  walkTree(dropdown, (node) => { if (node?.props?.className === 'tu-dropbtn') btn = node })
  btn?.props?.onClick?.()
  tree2 = render()
  let allItem
  walkTree(projectDropdownOf(tree2), (node) => {
    if (node?.props?.className === 'tu-dropitem' && textsOf(node).includes('全部项目')) allItem = allItem ?? node
  })
  allItem?.props?.onClick?.()
  check('切回全部项目后观察区消失', projectText(render()), '')
}

// —— T3-7：项目明细表点行 = 选中该项目 ——
{
  const tree = render()
  // 先切到「项目」明细标签
  let tabClicked = false
  walkTree(tree, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((child) => child === '项目')) {
      node.props?.onClick?.()
      tabClicked = true
    }
  })
  check('能切到项目明细表', tabClicked, true)
  const tableTree = render()
  let row
  walkTree(tableTree, (node) => {
    if (node?.type === 'tr' && typeof node.props?.onClick === 'function') row = row ?? node
  })
  check('项目表行可点', typeof row?.props?.onClick, 'function')
  row?.props?.onClick?.()
  check('点行后出现项目观察区', projectText(render()).includes('项目观察'), true)
}

// —— 回归：明细表 token 列在默认单位下仍是千分位精确值 ——
{
  const tree = await renderFresh()
  // 夹具里没有模型维度数据，切到项目表来断言明细表 token 列的格式
  let tabClicked = false
  walkTree(tree, (node) => {
    if (node?.type === 'button' && Array.isArray(node.children)
      && node.children.some((child) => child === '项目')) {
      node.props?.onClick?.()
      tabClicked = true
    }
  })
  check('可切到项目明细表', tabClicked, true)
  const flat = textsOf(render())
  // 21,000,000 在默认（'en'）单位下必须仍是千分位原数，不能被缩成 21M
  check('明细表 token 列默认仍为千分位', flat.includes('21,000,000'), true)
}

// —— i18n：新增 key 必须中英两侧都有 ——
{
  const dicts = localeRegistrations[0]?.dicts ?? {}
  check('文案含中英双语', dicts.zh !== undefined && dicts.en !== undefined, true)
  const zhKeys = Object.keys(dicts.zh ?? {}).sort()
  const enKeys = Object.keys(dicts.en ?? {}).sort()
  check('中英文案键一致', JSON.stringify(zhKeys), JSON.stringify(enKeys))
  for (const key of [
    'filter.project', 'filter.allProjects', 'project.section', 'project.grain.day',
    'project.grain.week', 'project.grain.month', 'project.weekUnit', 'project.modelNote',
    'project.emptyDays', 'project.singleBucket', 'project.allTime', 'project.retentionNote',
    'unit.b', 'unit.yi', 'unit.toggleTitle',
  ]) {
    check(`文案有 ${key}（zh）`, typeof dicts.zh?.[key], 'string')
    check(`文案有 ${key}（en）`, typeof dicts.en?.[key], 'string')
  }
}

//#endregion

if (failures.length > 0) {
  console.error('失败：')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('✓ 单项目观察 + 单位切换全部断言通过')
console.log('  周/月分桶（跨年周 / 月末 / 单日）· en/cn 单位 · 项目下拉与点行 · 粒度切换 · 空态 · 回归')
