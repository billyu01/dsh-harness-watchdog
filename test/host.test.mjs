/**
 * Host 半的集成测试：用一个假的 ctx 把插件跑起来，
 * 覆盖「说话」（注入提醒）和「动手」（救目标、拦住收轮）两条链路。
 * 不碰真实 DSH，也不碰用户正在运行的会话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject } from '../src/index.js'

function fakeCtx({ goals } = {}) {
  const handlers = new Map()
  const routes = new Map()
  const effects = []
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const services = { webServer }
  if (goals !== undefined) services.goals = goals
  const registered = []
  return {
    registered,
    on(event, fn) {
      registered.push({ event, fn, arity: fn.length })
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
    },
    effect(fn, label) {
      effects.push(label)
      return fn()
    },
    get(service) {
      return services[service]
    },
    logger: { warn() {} },
    fire(event, ...args) {
      return (handlers.get(event) || []).map((fn) => fn(...args))
    },
    async postExecute(exec, next) {
      let result
      for (const fn of handlers.get('tools/post-execute') || []) {
        result = await fn(exec, undefined, async () => next())
      }
      return result
    },
    routes,
    effects,
  }
}

/** 造一个假 agent：有 session，能 steer。 */
function fakeAgent(sessionId) {
  const steered = []
  return {
    session: { id: sessionId },
    steered,
    steer(message) {
      steered.push(message)
    },
  }
}

function fakeRes() {
  snapshot.headers = {}
  return {
    writeHead(status, headers) {
      snapshot.status = status
      snapshot.headers = headers
    },
    end(body) {
      snapshot.body = body
    },
  }
}
const snapshot = {}

test('插件导出面正确', () => {
  assert.equal(name, 'harness-watchdog')
  assert.ok(Array.isArray(inject))
  assert.ok(inject.includes('webServer'), 'webServer 必须写进 inject，否则拿不到服务')
})

test('没有待办时，工具调用后的决策原样透传', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const downstream = { kind: 'continue', additionalContexts: [{ existing: true }] }
  const out = await ctx.postExecute({ agent: fakeAgent('s1'), name: 'bash' }, () => downstream)
  assert.deepEqual(out, downstream, '不能改动别人的决策')
})

test('清单陈旧后，工具调用后会注入一条看门狗提醒', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const agent = fakeAgent('s1')
  ctx.fire('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  for (let i = 0; i < 20; i += 1) {
    ctx.fire('session/event', agent.session, { type: 'step/start', data: { step: i + 1 } })
    ctx.fire('session/event', agent.session, { type: 'tool/call', data: { name: 'bash' } })
  }
  const out = await ctx.postExecute({ agent, name: 'bash' }, () => ({ kind: 'continue' }))
  const msg = out.additionalContexts.find((m) => m.source.summary === 'plan-stale')
  assert.ok(msg, '应当注入清单陈旧提醒')
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'harness-watchdog')
  assert.match(msg.content[0].text, /todo_write/)
  assert.ok(Object.isFrozen(msg))
})

test('提醒只投递一次，不会每步都刷屏', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const agent = fakeAgent('s1')
  ctx.fire('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  for (let i = 0; i < 25; i += 1) {
    ctx.fire('session/event', agent.session, { type: 'step/start', data: { step: i + 1 } })
    ctx.fire('session/event', agent.session, { type: 'tool/call', data: { name: 'bash' } })
  }
  const first = await ctx.postExecute({ agent, name: 'bash' }, () => ({ kind: 'continue' }))
  assert.ok(first.additionalContexts.length >= 1, '这一批应当交付出去')
  const second = await ctx.postExecute({ agent, name: 'bash' }, () => ({ kind: 'continue' }))
  assert.equal(second.additionalContexts, undefined, '交付过的不能重复交付')
})

test('被阻止的决策也能带上提醒，且保留原有 feedback', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const agent = fakeAgent('s3')
  ctx.fire('session/event', agent.session, {
    type: 'goal/change',
    data: {
      operation: 'block',
      roundsStarted: 10,
      goal: { id: 'g', revision: 1, objective: 'x', phase: 'blocked', maxGoalRounds: 10 },
    },
  })
  const out = await ctx.postExecute({ agent, name: 'bash' }, () => ({ kind: 'block', feedback: '原样保留' }))
  assert.equal(out.kind, 'block')
  assert.equal(out.feedback, '原样保留')
  assert.equal(out.additionalContexts.length, 1)
})

// ── 干预：目标自动救援 ──────────────────────────────────────────────

test('目标因额度用尽被停：自动改大额度再恢复，并说明做了什么', async () => {
  const calls = []
  const goals = {
    get: () => ({ id: 'g', revision: 2, phase: 'blocked', maxGoalRounds: 256, roundsStarted: 256, activation: 'disarmed' }),
    edit(agent, ref, request) {
      calls.push({ op: 'edit', ref, request })
      return { id: ref.id, revision: ref.revision + 1 }
    },
    resume(agent, ref) {
      calls.push({ op: 'resume', ref })
      return {}
    },
  }
  const ctx = fakeCtx({ goals })
  apply(ctx)
  const agent = fakeAgent('sess-goal')
  ctx.fire('agent/status', { agent, status: 'idle' })
  ctx.fire('goal/activation-changed', { sessionId: 'sess-goal', goal: { id: 'g', revision: 2, activation: 'disarmed' } })

  assert.equal(calls.length, 2, '应当先改额度再恢复')
  assert.equal(calls[0].op, 'edit')
  assert.deepEqual(calls[0].ref, { id: 'g', revision: 2 })
  assert.equal(calls[0].request.maxGoalRounds, 384)
  assert.equal(calls[1].op, 'resume')
  assert.deepEqual(calls[1].ref, { id: 'g', revision: 3 }, '恢复要用改完之后的新 revision')

  // 动手之后要在对话里说清楚做了什么
  const out = await ctx.postExecute({ agent, name: 'bash' }, () => ({ kind: 'continue' }))
  assert.equal(out.additionalContexts.length, 1)
  assert.match(out.additionalContexts[0].content[0].text, /自动把额度从 256 提到 384/)
})

test('真受阻（额度没用完）时不动手', () => {
  const calls = []
  const goals = {
    get: () => ({ id: 'g', revision: 1, phase: 'blocked', maxGoalRounds: 256, roundsStarted: 40, activation: 'disarmed' }),
    edit() { calls.push('edit') },
    resume() { calls.push('resume') },
  }
  const ctx = fakeCtx({ goals })
  apply(ctx)
  const agent = fakeAgent('s')
  ctx.fire('agent/status', { agent })
  ctx.fire('goal/activation-changed', { sessionId: 's', goal: { id: 'g', revision: 1 } })
  assert.equal(calls.length, 0)
})

test('目标被悄悄解除武装：自动重新武装', () => {
  const calls = []
  const goals = {
    get: () => ({ id: 'g', revision: 5, phase: 'active', maxGoalRounds: 256, roundsStarted: 40, activation: 'disarmed' }),
    edit() { calls.push('edit') },
    resume(agent, ref) { calls.push(['resume', ref]) },
  }
  const ctx = fakeCtx({ goals })
  apply(ctx)
  const agent = fakeAgent('s2')
  ctx.fire('agent/status', { agent })
  ctx.fire('goal/activation-changed', { sessionId: 's2', goal: { id: 'g', revision: 5 } })
  assert.deepEqual(calls, [['resume', { id: 'g', revision: 5 }]], '只恢复，不改额度')
})

test('没有 goals 服务时插件照样能用（只提醒，不动手）', () => {
  const ctx = fakeCtx()
  assert.doesNotThrow(() => apply(ctx))
  const agent = fakeAgent('s')
  assert.doesNotThrow(() => {
    ctx.fire('agent/status', { agent })
    ctx.fire('goal/activation-changed', { sessionId: 's', goal: { id: 'g', revision: 1 } })
  })
})

test('救援失败时不抛错，也不把这次尝试记成成功', () => {
  let attempts = 0
  const goals = {
    get: () => ({ id: 'g', revision: 1, phase: 'blocked', maxGoalRounds: 10, roundsStarted: 10, activation: 'disarmed' }),
    edit() { attempts += 1; throw new Error('模拟失败') },
    resume() {},
  }
  const ctx = fakeCtx({ goals })
  apply(ctx)
  const agent = fakeAgent('s')
  ctx.fire('agent/status', { agent })
  assert.doesNotThrow(() => {
    ctx.fire('goal/activation-changed', { sessionId: 's', goal: { id: 'g', revision: 1 } })
  })
  assert.equal(attempts, 1)
  // 失败后允许重试
  ctx.fire('goal/activation-changed', { sessionId: 's', goal: { id: 'g', revision: 1 } })
  assert.equal(attempts, 2, '失败的尝试不该被记成已处理')
})

// ── 干预：拦住收轮，强制刷新清单 ────────────────────────────────────

test('本轮干了活但清单没更新：拦住收轮，steer 一条强制刷新指令', () => {
  const ctx = fakeCtx()
  apply(ctx)
  const agent = fakeAgent('s-turn')
  ctx.fire('agent/status', { agent })
  ctx.fire('session/event', agent.session, { type: 'turn/start', data: { turn: 4 } })
  for (let i = 0; i < 20; i += 1) {
    ctx.fire('session/event', agent.session, { type: 'step/start', data: { step: i + 1 } })
    ctx.fire('session/event', agent.session, { type: 'tool/call', data: { name: 'bash' } })
  }
  ctx.fire('agent/turn-stopping', { agent, turn: 4 })

  assert.equal(agent.steered.length, 1, '应当把这一轮拉回来')
  const msg = agent.steered[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'harness-watchdog')
  assert.equal(msg.source.summary, 'force-plan')
  assert.match(msg.content[0].text, /先不要结束/)

  // 同一轮不能反复拦
  ctx.fire('agent/turn-stopping', { agent, turn: 4 })
  assert.equal(agent.steered.length, 1)
})

test('本轮已经刷过清单就不拦', () => {
  const ctx = fakeCtx()
  apply(ctx)
  const agent = fakeAgent('s-turn2')
  ctx.fire('agent/status', { agent })
  ctx.fire('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  ctx.fire('session/event', agent.session, { type: 'todo/write', data: { todos: [{ content: '甲', status: 'in_progress' }] } })
  for (let i = 0; i < 12; i += 1) {
    ctx.fire('session/event', agent.session, { type: 'tool/call', data: { name: 'bash' } })
  }
  ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 0)
})

// ── 状态接口 ───────────────────────────────────────────────────────

test('状态接口返回快照，并带上干预统计与版本号', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.ok(ctx.routes.has('/harness-watchdog/status'))

  const a = fakeAgent('sess-a')
  const b = fakeAgent('sess-b')
  ctx.fire('agent/status', { agent: a })
  ctx.fire('session/event', a.session, { type: 'turn/start', data: { turn: 1 } })
  ctx.fire('session/event', a.session, { type: 'tool/call', data: { name: 'bash' } })
  ctx.fire('session/event', b.session, {
    type: 'goal/change',
    data: {
      operation: 'block',
      roundsStarted: 40,
      goal: { id: 'g', revision: 2, objective: 'y', phase: 'blocked', maxGoalRounds: 40 },
    },
  })

  await ctx.routes.get('/harness-watchdog/status')({ method: 'GET' }, fakeRes())
  const payload = JSON.parse(snapshot.body)
  assert.equal(payload.ok, true)
  assert.equal(typeof payload.version, 'string')
  assert.ok(payload.intervene && typeof payload.intervene.rescue === 'number')
  const withGoal = payload.items.find((i) => i.sessionId === 'sess-b')
  assert.equal(withGoal.goal.kind, 'blocked')
})

test('畸形事件不会抛错，也不影响后续处理', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.doesNotThrow(() => {
    ctx.fire('session/event', fakeAgent('s4').session, null)
    ctx.fire('session/event', null, { type: 'turn/start' })
    ctx.fire('session/event', fakeAgent('s4').session, { type: 'tool/call' })
    ctx.fire('agent/turn-stopping', {})
    ctx.fire('goal/activation-changed', {})
  })
  const out = await ctx.postExecute({ agent: {}, name: 'bash' }, () => ({ kind: 'continue' }))
  assert.equal(out.kind, 'continue')
})

test('没有 webServer 服务时插件照样能加载', () => {
  const ctx = fakeCtx()
  ctx.get = () => undefined
  assert.doesNotThrow(() => apply(ctx))
})

test('沉默过久：连续工具调用没有正文时，宿主半会注入一条可见提醒', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const agent = fakeAgent('s-silence')
  ctx.fire('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  ctx.fire('session/event', agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '我先看一下仓库结构' }] } },
  })
  for (let i = 0; i < 12; i += 1) {
    ctx.fire('session/event', agent.session, { type: 'step/start', data: { step: i + 1 } })
    ctx.fire('session/event', agent.session, { type: 'tool/call', data: { name: 'bash' } })
  }
  const out = await ctx.postExecute({ agent, name: 'bash' }, () => ({ kind: 'continue' }))
  const msg = out.additionalContexts.find((m) => m.source.summary === 'silence')
  assert.ok(msg, '沉默过久必须注入提醒')
  assert.match(msg.content[0].text, /没有输出任何正文/)
})

// ── 契约回归测试：这几个用例专门防止「钩子注册错把整个会话搞崩」 ──────────

test('绝不注册 agent/pre-step（它是瀑布式钩子，注册错会让每一轮第一步就崩）', () => {
  const ctx = fakeCtx()
  apply(ctx)
  const bad = ctx.registered.filter((h) => h.event === 'agent/pre-step')
  assert.equal(bad.length, 0, 'agent/pre-step 是瀑布式钩子，不能用普通监听器注册')
})

test('所有注册的钩子都符合契约：瀑布式必须接收 next', () => {
  const ctx = fakeCtx()
  apply(ctx)
  const waterfall = new Set(['agent/pre-step', 'tools/post-execute', 'tools/pre-execute'])
  for (const h of ctx.registered) {
    if (waterfall.has(h.event)) {
      assert.ok(h.arity >= 2, `${h.event} 是瀑布式，监听的函数必须接收 next，实际参数个数 ${h.arity}`)
    }
  }
  const post = ctx.registered.filter((h) => h.event === 'tools/post-execute')
  assert.equal(post.length, 1, '只应当注册一个 tools/post-execute')
  assert.ok(post[0].arity >= 3, 'tools/post-execute 的签名是 (exec, result, next)')
})

test('瀑布式钩子必须把下游决策原样交回，不能自己拼一个残缺对象', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const downstream = { kind: 'continue', marker: 'x' }
  const out = await ctx.postExecute({ agent: fakeAgent('s') }, () => downstream)
  assert.equal(out, downstream, '没有待交付内容时必须原样返回下游决策')
})

test('下游决策是 undefined 时也原样交回，不能自己造对象（否则框架读 kind 会崩）', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const out = await ctx.postExecute({ agent: fakeAgent('s') }, () => undefined)
  assert.equal(out, undefined)
})

test('配置 enabled: false 时整体不工作（留一个总开关）', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: false })
  const agent = fakeAgent('s-off')
  ctx.fire('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  for (let i = 0; i < 30; i += 1) {
    ctx.fire('session/event', agent.session, { type: 'step/start', data: { step: i + 1 } })
    ctx.fire('session/event', agent.session, { type: 'tool/call', data: { name: 'bash' } })
  }
  const out = await ctx.postExecute({ agent, name: 'bash' }, () => ({ kind: 'continue' }))
  assert.equal(out.additionalContexts, undefined, '关掉之后不应该注入任何东西')
})
