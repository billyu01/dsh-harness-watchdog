/**
 * dsh-harness-watchdog —— Host 半。
 *
 * 这个插件做两件事，一件是「说话」，一件是「动手」：
 *
 *   说话（对模型）：提醒它重建任务清单、别一轮干太久。走官方插件在用的
 *     `tools/post-execute` 注入通道，不改工具输出、不阻止调用。
 *
 *   动手（对状态）：这是用户明确要求的重点。框架留了两个口子，都在源码里核对过：
 *     - `agent/turn-stopping` 之后，只要收件箱的「下一步」非空这一轮就不会结束，
 *       所以在那里 `agent.steer(...)` 能把一轮拉回来，强制先把清单刷新掉；
 *     - `goals` 服务对插件开放 `get/edit/resume`，且不校验「必须有人类直接发话」，
 *       所以能把因额度用尽而停住的目标自动救回来、把被悄悄解除武装的目标重新武装。
 *
 *   动手是有边界的，默认值见 src/intervene.js：同一个目标最多自动救 3 次、
 *   重新武装 5 次，额度有绝对上限，每次动作都会在对话里说清楚做了什么。
 *
 * 设计底线（用户「不要影响已有正常功能」的硬要求）：
 *   - 不 import 任何 @deepseek-ai/* 包（profile 目录解析不到）。
 *   - 不改会话记录、不注册会话投影、不动别人的配置。
 *   - 一切异常都吞掉并记账，绝不让看门狗自身出错打断会话。
 */
import { randomUUID } from 'node:crypto'
import { createWatcher } from './policy.js'
import { createIntervener } from './intervene.js'

export const name = 'harness-watchdog'

/**
 * webServer 是硬依赖，必须写进 inject。
 * 如果只写 inject: [] 然后用 ctx.get('webServer') 读，插件会在 webServer
 * 就绪之前先执行，于是拿不到服务、静默跳过路由注册 —— 这次踩过这个坑。
 */
export const inject = ['webServer']

/**
 * 插件版本。状态接口会把它带出来，用来确认「改了源码之后有没有真的热生效」——
 * 这个包不在 HMR 的监听目录里，改完源码后靠这个字段判断。
 */
const WATCHDOG_VERSION = '0.3.1'

/** 状态保留多久没有活动就丢弃（毫秒）。 */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000

/**
 * 构造一条模型可见的合成用户消息。
 * 与核心包 createUserMessage 的运行时行为一致：补 role 和 id，然后冻结。
 * 这里手写而不用 import，是因为 profile 插件解析不到 @deepseek-ai/dsh-llm。
 */
function createUserMessage(input) {
  return Object.freeze({ ...input, role: 'user', id: randomUUID() })
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 一条状态记录：一个会话一个 watcher，外加它最近一次动作的时间。 */
function makeEntry() {
  return {
    watcher: createWatcher(),
    lastActivityAt: 0,
    /** 待投递的提醒（在下一次工具调用之后注入） */
    queue: [],
    delivered: 0,
    lastDeliveredAt: null,
    /** 这个会话对应的活 agent，动手时要用 */
    agent: null,
    /** 已经对这个会话做过的干预，供状态接口展示 */
    interventions: [],
  }
}

/** 把一段文本排进「下一次工具调用之后交给模型」的队列。 */
function enqueue(entry, text, rule) {
  entry.queue.push({ kind: 'remind', rule, text })
  if (entry.queue.length > 5) entry.queue.splice(0, entry.queue.length - 5)
}

function actionToMessage(action) {
  return createUserMessage({
    content: [{ type: 'text', text: action.text }],
    source: { kind: 'harness-watchdog', form: 'notice', summary: action.rule },
  })
}

/**
 * 钩子契约表（逐条核对自 DSH 0.2.1 源码，改动前请重新核对）。
 *
 *   broadcast  ctx.on(名字, (载荷) => void)              返回值被忽略
 *   serial     ctx.on(名字, async (载荷) => void)        顺序执行，返回值被忽略
 *   waterfall  ctx.on(名字, (载荷..., next) => next())   **必须调用 next() 并把结果交回去**
 *
 * 瀑布式钩子如果返回 undefined，框架会在后面读它返回值的字段时报
 * 「Cannot read properties of undefined」——这正是 0.2.0 版把它误注册成广播式后炸掉的原因。
 */
const HOOK_CONTRACT = {
  'agent/created': 'broadcast',
  'agent/status': 'broadcast',
  'agent/turn-stopping': 'serial',
  'session/event': 'broadcast',
  'goal/activation-changed': 'broadcast',
  'tools/post-execute': 'waterfall',
  'agent/pre-step': 'waterfall',
  'tools/pre-execute': 'waterfall',
}

/** 允许用普通监听器注册的广播式/串行钩子。 */
const SAFE_PLAIN_HOOKS = {
  'agent/created': 'broadcast',
  'agent/status': 'broadcast',
  'agent/turn-stopping': 'serial',
  'session/event': 'broadcast',
  'goal/activation-changed': 'broadcast',
}

export function apply(ctx, config = {}) {
  const sessions = new Map()
  const intervener = createIntervener(config.intervene || {})
  const goals = ctx.get('goals')

  // 熔断：连续出错到阈值就整体停手，宁可不出力也不能拖垮正常会话。
  const MAX_FAILURES = 5
  let failures = 0
  let disabled = config.enabled === false

  function noteFailure(err) {
    failures += 1
    if (failures >= MAX_FAILURES && !disabled) {
      disabled = true
      reportInternalError(ctx, new Error(`连续 ${failures} 次内部错误，看门狗已自动停手：${err && err.message}`))
    } else {
      reportInternalError(ctx, err)
    }
  }

  /**
   * 按契约注册一个「普通」钩子（广播式或串行式）。
   * 契约不符时宁可不注册——注册错最坏的后果是把别人整条流程搞崩。
   */
  function safeOn(name, fn) {
    const kind = HOOK_CONTRACT[name]
    const expected = SAFE_PLAIN_HOOKS[name]
    if (typeof ctx.on !== 'function') return
    if (expected === undefined) {
      noteFailure(new Error(`拒绝按普通监听器注册 ${name}：契约是 ${kind || '未知'}`))
      return
    }
    // 注意：不同钩子的位置参数个数不一样（session/event 是 (session, event)），
    // 所以必须把收到的参数原样透传，不能只取第一个。
    ctx.on(name, (...args) => {
      if (disabled) return
      try {
        fn(...args)
      } catch (err) {
        noteFailure(err)
      }
    })
  }

  function entryOf(session) {
    const id = session && session.id ? session.id : String(session)
    let entry = sessions.get(id)
    if (!entry) {
      entry = makeEntry()
      sessions.set(id, entry)
    }
    return entry
  }

  function prune(now) {
    for (const [id, entry] of sessions) {
      if (now - entry.lastActivityAt > SESSION_TTL_MS) sessions.delete(id)
    }
  }

  function remember(kind, text) {
    return { kind, text, at: Date.now() }
  }

  // ── 1. 记住「会话 → 活 agent」的对应关系，动手时要靠它 ────────────────
  //
  // ⚠️ 这里踩过一次大坑，务必看清：
  //   `agent/pre-step` 是「瀑布式」钩子，监听器必须调用 next() 并返回它的结果。
  //   上一版用普通监听器注册它、返回 undefined，导致框架读 decision.kind 时崩掉，
  //   表现为「每一轮的第一步就报 Cannot read properties of undefined (reading 'kind')」。
  //   所以：只用广播式事件记 agent；瀑布式事件要么按契约实现，要么绝对不碰。
  for (const event of ['agent/created', 'agent/status', 'agent/turn-stopping']) {
    safeOn(event, (payload) => captureAgent(payload && payload.agent))
  }

  function captureAgent(agent) {
    if (!agent || typeof agent !== 'object') return
    const session = agent.session
    if (!session || !session.id) return
    const entry = entryOf(session)
    entry.agent = agent
    entry.lastActivityAt = Date.now()
  }

  // ── 2. 吃会话事件流，算出「该提醒什么」 ────────────────────────────────
  // 事件是只读的：不改写任何会话记录，只更新内存里的状态。
  safeOn('session/event', (session, event) => {
    if (!session || !event) return
    const entry = entryOf(session)
    entry.lastActivityAt = Date.now()
    const actions = entry.watcher.observe(event)
    for (const action of actions) {
      if (action.kind === 'remind') entry.queue.push(action)
      else if (action.kind === 'notify' && action.wakeup) entry.queue.push(action)
    }
    if (entry.queue.length > 5) entry.queue.splice(0, entry.queue.length - 5)
  })

  // ── 3. 在工具调用之后把提醒交给模型 ───────────────────────────────────
  // 官方 repeat-tool-reminder 用的就是这个通道：只追加 additionalContexts，
  // 不改工具输出、不阻止调用。
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    // 先让框架自己的决策算出来。next() 抛错属于框架错误，必须原样抛出，不能吞。
    const downstream = await next()
    try {
      if (disabled) return downstream
      // 瀑布式的铁律：交回去的东西必须还是框架给的那个决策对象。
      // 下游不是对象时（例如返回 undefined），一律原样交回，绝不自己拼。
      if (downstream === null || typeof downstream !== 'object') return downstream

      const session = exec && exec.agent && exec.agent.session
      if (!session || !session.id) return downstream
      const entry = sessions.get(session.id)
      if (!entry || entry.queue.length === 0) return downstream

      const pending = entry.queue.splice(0, entry.queue.length)
      const contexts = pending.map(actionToMessage)
      if (contexts.length === 0) return downstream
      entry.delivered += contexts.length
      entry.lastDeliveredAt = Date.now()

      const tail = Array.isArray(downstream.additionalContexts) ? downstream.additionalContexts : []
      if (downstream.kind === 'block') {
        return { kind: 'block', feedback: downstream.feedback, additionalContexts: [...contexts, ...tail] }
      }
      return { ...downstream, additionalContexts: [...contexts, ...tail] }
    } catch (err) {
      noteFailure(err)
      return downstream
    }
  })

  // ── 4. 干预一：拦住收轮，强制把任务清单刷新掉 ─────────────────────────
  // 核心循环在这一步之后会检查「下一步」是否为空，非空就继续这一轮。
  safeOn('agent/turn-stopping', (payload) => {
    const agent = payload && payload.agent
    const session = agent && agent.session
    if (!session || !session.id) return
    const entry = sessions.get(session.id)
    if (!entry) return

    // 兼容性：不同版本可能没有 steer，没有就退化成普通提醒，绝不让它抛错。
    if (typeof agent.steer !== 'function') return

    const snap = entry.watcher.snapshot()
    const decision = intervener.decideTurnStopping({
      sessionId: session.id,
      turn: payload.turn ?? snap.turn,
      toolCallsThisTurn: snap.toolCallsThisTurn,
      toolCallsSinceTodo: snap.toolCallsSinceTodo,
      todoWritten: snap.todoWritten,
      todoSummary: snap.todoSummary,
      lastTurnText: snap.lastTurnText,
    })
    if (!decision) return

    agent.steer(
      createUserMessage({
        content: [{ type: 'text', text: decision.text }],
        source: { kind: 'harness-watchdog', form: 'notice', summary: 'force-plan' },
      }),
    )
    intervener.noteDone(decision)
    entry.interventions.unshift(
      remember(
        'force-plan',
        decision.reason === 'claim-mismatch'
          ? `第 ${decision.turn} 轮：声称完成但清单还有 ${decision.openItems} 项未完成，已拦下要求对账`
          : `第 ${decision.turn} 轮拦住收轮，要求先刷新任务清单`,
      ),
    )
    entry.interventions.length = Math.min(entry.interventions.length, 10)
  })

  // ── 5. 干预二：目标静默停住时自动救回来 ───────────────────────────────
  function tryInterveneGoal(session) {
    // 兼容性：目标服务或它的方法在别的版本里可能不存在，缺任何一环都安静退出。
    if (!goals || typeof goals.get !== 'function') return
    const entry = sessions.get(session && session.id)
    const agent = entry && entry.agent
    if (!agent) return

    let view
    try {
      view = goals.get(agent)
    } catch {
      // agent 不是当前活实例（例如已被替换）——不是错误，等下一次事件。
      return
    }
    const decision = intervener.decideGoal(view)
    if (!decision) return

    try {
      if (decision.kind === 'rescue') {
        if (typeof goals.edit !== 'function' || typeof goals.resume !== 'function') return
        const edited = goals.edit(agent, decision.ref, { maxGoalRounds: decision.newMaxGoalRounds })
        const ref = { id: edited.id, revision: edited.revision }
        goals.resume(agent, ref)
        intervener.noteDone(decision)
        const text =
          `【看门狗·已动手】目标因为轮次额度用尽被框架停掉了，已经自动把额度从 ` +
          `${decision.previousMaxGoalRounds} 提到 ${decision.newMaxGoalRounds} 轮并恢复（第 ` +
          `${decision.attempt}/${decision.maxAttempts} 次自动救援）。如果不想继续，直接说停。`
        enqueue(entry, text, 'auto-rescue')
        entry.interventions.unshift(
          remember('auto-rescue', `把额度 ${decision.previousMaxGoalRounds} → ${decision.newMaxGoalRounds} 并恢复目标`),
        )
      } else if (decision.kind === 'rearm') {
        if (typeof goals.resume !== 'function') return
        goals.resume(agent, decision.ref)
        intervener.noteDone(decision)
        enqueue(
          entry,
          `【看门狗·已动手】目标的自动续跑被悄悄停用了，已经重新开启（第 ` +
            `${decision.attempt}/${decision.maxAttempts} 次）。`,
          'auto-rearm',
        )
        entry.interventions.unshift(remember('auto-rearm', '重新开启目标的自动续跑'))
      }
      entry.interventions.length = Math.min(entry.interventions.length, 10)
    } catch (err) {
      // 救不动就退回「只提醒」，并把这次尝试作废，让下一轮还能再试。
      intervener.noteFailed(decision)
      reportInternalError(ctx, err)
    }
  }

  // 目标状态变化：目标服务会发 goal/activation-changed（解除武装只有这一条线索），
  // 会话日志里则是 goal/change。两条路都走，任何一条拿不到都不影响另一条。
  safeOn('goal/activation-changed', (payload) => {
    if (!payload || !payload.sessionId) return
    tryInterveneGoal({ id: payload.sessionId })
  })
  safeOn('session/event', (session, event) => {
    if (!session || !event || event.type !== 'goal/change') return
    tryInterveneGoal(session)
  })

  // ── 6. 给浏览器半的状态接口 ──────────────────────────────────────────
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/harness-watchdog/status',
          handler: async (req, res) => {
            try {
              const now = Date.now()
              prune(now)
              const items = []
              for (const [id, entry] of sessions) {
                items.push({
                  sessionId: id,
                  ...entry.watcher.snapshot(now),
                  delivered: entry.delivered,
                  lastDeliveredAt: entry.lastDeliveredAt,
                  idleMs: now - entry.lastActivityAt,
                  interventions: entry.interventions,
                })
              }
              items.sort((a, b) => a.idleMs - b.idleMs)
              json(res, 200, {
                ok: true,
                version: WATCHDOG_VERSION,
                intervene: intervener.stats(),
                items,
                now,
              })
            } catch (err) {
              json(res, 200, { ok: false, items: [], error: String((err && err.message) || err) })
            }
          },
        }),
      'harness-watchdog: /harness-watchdog/status route',
    )
  }
}

/** 内部错误只记账，绝不冒泡。 */
function reportInternalError(ctx, err) {
  try {
    const logger = ctx && typeof ctx.logger === 'object' ? ctx.logger : undefined
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[harness-watchdog] 内部错误：', err)
    }
  } catch {
    /* 连记账都失败就算了，不能因此影响会话 */
  }
}
