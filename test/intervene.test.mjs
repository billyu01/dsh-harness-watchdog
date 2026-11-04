/**
 * 干预决策的单元测试。
 * 这一层是纯判断，不碰 DSH，所以可以把「该不该动手」的边界钉死在这里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIntervener, DEFAULT_INTERVENE } from '../src/intervene.js'

const blocked = (over = {}) => ({
  id: 'goal-1',
  revision: 2,
  objective: '把端到端跑通',
  phase: 'blocked',
  maxGoalRounds: 256,
  roundsStarted: 256,
  activation: 'disarmed',
  ...over,
})

test('额度用尽导致阻塞：决定动手，并把额度加到位', () => {
  const iv = createIntervener()
  const d = iv.decideGoal(blocked())
  assert.ok(d, '应当产出救援决策')
  assert.equal(d.kind, 'rescue')
  assert.deepEqual(d.ref, { id: 'goal-1', revision: 2 })
  assert.equal(d.previousMaxGoalRounds, 256)
  // 已用 256，按 0.5 增长 = 128，比下限 64 大，取 128；256 + 128 = 384
  assert.equal(d.newMaxGoalRounds, 384)
  assert.match(d.reason, /额度用尽/)
})

test('额度增长有下限：轮数很少时也要加得动', () => {
  const iv = createIntervener()
  const d = iv.decideGoal(blocked({ maxGoalRounds: 10, roundsStarted: 10 }))
  assert.equal(d.newMaxGoalRounds, 10 + 64)
})

test('真受阻（额度没用完）不动手', () => {
  const iv = createIntervener()
  assert.equal(iv.decideGoal(blocked({ maxGoalRounds: 256, roundsStarted: 40 })), null)
})

test('同一个目标救援次数有上限，超了就不动', () => {
  const iv = createIntervener()
  for (let i = 0; i < DEFAULT_INTERVENE.maxRescuesPerGoal; i += 1) {
    const d = iv.decideGoal(blocked({ revision: 10 + i }))
    assert.ok(d, `第 ${i + 1} 次应当允许`)
    iv.noteDone(d)
  }
  assert.equal(iv.decideGoal(blocked({ revision: 99 })), null, '超过上限后必须停手')
  assert.equal(iv.stats().rescue, DEFAULT_INTERVENE.maxRescuesPerGoal)
})

test('额度有绝对上限，不会无限加', () => {
  const iv = createIntervener()
  const d = iv.decideGoal(
    blocked({ maxGoalRounds: DEFAULT_INTERVENE.rescueMaxRounds, roundsStarted: DEFAULT_INTERVENE.rescueMaxRounds }),
  )
  assert.equal(d, null, '到顶了就救不动，不许越界')
})

test('同一个版本不重复尝试（失败时不会打成死循环）', () => {
  const iv = createIntervener()
  const first = iv.decideGoal(blocked())
  assert.ok(first)
  iv.noteFailed(first)
  assert.ok(iv.decideGoal(blocked()), '失败后应当允许重试')
  const second = iv.decideGoal(blocked())
  assert.equal(second, null, '同一次尝试不能连续触发')
})

test('目标被悄悄解除武装：决定重新武装', () => {
  const iv = createIntervener()
  const d = iv.decideGoal({ id: 'g', revision: 3, phase: 'active', maxGoalRounds: 256, roundsStarted: 40, activation: 'disarmed' })
  assert.ok(d)
  assert.equal(d.kind, 'rearm')
  assert.deepEqual(d.ref, { id: 'g', revision: 3 })
})

test('目标正常进行中（仍是武装状态）不动手', () => {
  const iv = createIntervener()
  assert.equal(
    iv.decideGoal({ id: 'g', revision: 3, phase: 'active', maxGoalRounds: 256, roundsStarted: 40, activation: 'armed' }),
    null,
  )
})

test('用户主动暂停的目标不许自动恢复', () => {
  const iv = createIntervener()
  assert.equal(
    iv.decideGoal({ id: 'g', revision: 3, phase: 'paused', maxGoalRounds: 256, roundsStarted: 40, activation: 'disarmed' }),
    null,
  )
})

test('没有目标时不动手', () => {
  const iv = createIntervener()
  assert.equal(iv.decideGoal(undefined), null)
  assert.equal(iv.decideGoal({}), null)
})

test('这一轮干了活但清单没更新：决定拦住收轮', () => {
  const iv = createIntervener()
  const d = iv.decideTurnStopping({
    sessionId: 's1',
    turn: 7,
    toolCallsThisTurn: 12,
    toolCallsSinceTodo: 20,
    todoWritten: true,
  })
  assert.ok(d, '应当拦住')
  assert.equal(d.kind, 'forcePlan')
  assert.match(d.text, /先不要结束/)
  assert.match(d.text, /todo_write/)
})

test('本轮没什么实质工作就不拦（避免打扰简单对话）', () => {
  const iv = createIntervener()
  assert.equal(
    iv.decideTurnStopping({ sessionId: 's1', turn: 7, toolCallsThisTurn: 2, toolCallsSinceTodo: 20 }),
    null,
  )
})

test('本轮已经刷过清单就不拦', () => {
  const iv = createIntervener()
  assert.equal(
    iv.decideTurnStopping({ sessionId: 's1', turn: 7, toolCallsThisTurn: 12, toolCallsSinceTodo: 0 }),
    null,
  )
})

test('同一轮只拦一次', () => {
  const iv = createIntervener()
  const input = { sessionId: 's1', turn: 7, toolCallsThisTurn: 12, toolCallsSinceTodo: 20 }
  assert.ok(iv.decideTurnStopping(input))
  assert.equal(iv.decideTurnStopping(input), null, '同一轮不能反复拦')
  assert.ok(iv.decideTurnStopping({ ...input, turn: 8 }), '换一轮可以再拦')
})

test('可以整体关闭动手能力', () => {
  const iv = createIntervener({ autoRescueGoal: false, rearmDisarmedGoal: false, forcePlanRefresh: false })
  assert.equal(iv.decideGoal(blocked()), null)
  assert.equal(
    iv.decideGoal({ id: 'g', revision: 1, phase: 'active', maxGoalRounds: 10, roundsStarted: 1, activation: 'disarmed' }),
    null,
  )
  assert.equal(iv.decideTurnStopping({ sessionId: 's', turn: 1, toolCallsThisTurn: 99, toolCallsSinceTodo: 99 }), null)
  assert.ok(iv.stats().skipped >= 2, '跳过次数应当被记账')
})

// ── 收尾对账：任务做完了但清单没更新 ──────────────────────────────

test('声称完成但清单还有未完成项：拦下要求对账', () => {
  const iv = createIntervener()
  const d = iv.decideTurnStopping({
    sessionId: 's',
    turn: 39,
    toolCallsThisTurn: 4,
    toolCallsSinceTodo: 3,
    todoSummary: { total: 5, done: 2, doing: 1 },
    lastTurnText: '进度：已完成 5 项 / 剩余 0 项（包已构建校验、test 已推送）',
  })
  assert.ok(d, '这种矛盾必须拦下')
  assert.equal(d.reason, 'claim-mismatch')
  assert.equal(d.openItems, 3)
  assert.match(d.text, /还有 3 项没有标成完成/)
  assert.match(d.text, /先不要结束/)
})

test('声称完成且清单确实全都完成：不拦', () => {
  const iv = createIntervener()
  const d = iv.decideTurnStopping({
    sessionId: 's',
    turn: 1,
    toolCallsThisTurn: 4,
    toolCallsSinceTodo: 3,
    todoSummary: { total: 5, done: 5, doing: 0 },
    lastTurnText: '全部完成',
  })
  assert.equal(d, null)
})

test('清单还有未完成项，但模型没说完成：不拦（可能只是在等用户）', () => {
  const iv = createIntervener()
  const d = iv.decideTurnStopping({
    sessionId: 's',
    turn: 1,
    toolCallsThisTurn: 4,
    toolCallsSinceTodo: 3,
    todoSummary: { total: 5, done: 2, doing: 1 },
    lastTurnText: '包已经打好，等你上传测试后告诉我结果',
  })
  assert.equal(d, null)
})

test('没有清单时不会因为「声称完成」去拦', () => {
  const iv = createIntervener()
  const d = iv.decideTurnStopping({
    sessionId: 's',
    turn: 1,
    toolCallsThisTurn: 3,
    toolCallsSinceTodo: 3,
    todoSummary: null,
    lastTurnText: '已完成',
  })
  assert.equal(d, null)
})

test('原有的陈旧规则仍然生效（reason 为 stale）', () => {
  const iv = createIntervener()
  const d = iv.decideTurnStopping({
    sessionId: 's',
    turn: 2,
    toolCallsThisTurn: 20,
    toolCallsSinceTodo: 20,
    todoSummary: { total: 3, done: 3, doing: 0 },
    lastTurnText: '继续干活',
  })
  assert.ok(d)
  assert.equal(d.reason, 'stale')
})
