/**
 * 看门狗纯逻辑的单元测试。
 * 运行：node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatcher, humanDuration, DEFAULT_CONFIG } from '../src/policy.js';

/** 造一个「工具调用」事件 */
function toolCall(name = 'bash', step = 1, turn = 1) {
  return { type: 'tool/call', data: { name }, time: 1_000_000, seq: 1 };
}

function run(watcher, records) {
  const out = [];
  for (const r of records) out.push(...watcher.observe(r));
  return out;
}

/** 连续 n 次工具调用，配好 step/start */
function manyToolCalls(n, startStep = 1, turn = 1, time = 1_000_000) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ type: 'step/start', data: { step: startStep + i, turn }, time });
    out.push({ type: 'tool/call', data: { name: 'bash' }, time, seq: i });
  }
  return out;
}

test('简单任务不打扰：20 次工具调用以内不提醒', () => {
  const w = createWatcher();
  const actions = run(w, [{ type: 'turn/start', data: { turn: 1 }, time: 1 }, ...manyToolCalls(10)]);
  assert.equal(actions.length, 0);
});

test('长时间不写清单：会提醒，而且文案里给出具体步数', () => {
  const w = createWatcher();
  const actions = run(w, [
    { type: 'turn/start', data: { turn: 1 }, time: 1 },
    ...manyToolCalls(22),
  ]);
  const plan = actions.filter((a) => a.rule === 'plan-stale');
  assert.equal(plan.length, 1, '应当只提醒一次');
  assert.equal(plan[0].kind, 'remind');
  assert.equal(plan[0].target, 'next-step');
  assert.equal(plan[0].wakeup, false, '计划提醒不应该强行唤醒新轮次');
  assert.match(plan[0].text, /还没有写过任务清单/);
  assert.match(plan[0].text, /todo_write/);
});

test('写过清单后再陈旧：提醒文案区分「未更新」', () => {
  const w = createWatcher();
  const actions = run(w, [
    { type: 'turn/start', data: { turn: 1 }, time: 1 },
    { type: 'todo/write', data: { todos: [{ content: '甲', status: 'in_progress' }] }, time: 2 },
    ...manyToolCalls(22, 1),
  ]);
  const plan = actions.filter((a) => a.rule === 'plan-stale');
  assert.equal(plan.length, 1);
  assert.match(plan[0].text, /没有更新/);
});

test('清单刷新后计数清零：短短几步不会立刻又提醒', () => {
  const w = createWatcher();
  const actions = run(w, [
    { type: 'turn/start', data: { turn: 1 }, time: 1 },
    ...manyToolCalls(20),
    { type: 'todo/write', data: { todos: [] }, time: 2 },
    ...manyToolCalls(5, 40),
  ]);
  assert.equal(actions.filter((a) => a.rule === 'plan-stale').length, 1);
  assert.equal(w.snapshot().toolCallsSinceTodo, 5);
});

test('单轮过长：60 步提醒一次，同一轮不重复', () => {
  const w = createWatcher();
  const actions = run(w, [
    { type: 'turn/start', data: { turn: 7 }, time: 1 },
    ...manyToolCalls(70),
  ]);
  const long = actions.filter((a) => a.rule === 'long-turn');
  assert.equal(long.length, 1);
  assert.match(long[0].text, /第 60 步/);
});

test('目标额度用尽被阻塞：给出「先改大额度再恢复」的正确指引', () => {
  const w = createWatcher();
  const actions = run(w, [
    {
      type: 'goal/change',
      time: 5,
      data: {
        operation: 'block',
        roundsStarted: 256,
        goal: {
          id: 'goal-1',
          revision: 2,
          objective: '端到端跑通',
          phase: 'blocked',
          maxGoalRounds: 256,
        },
      },
    },
  ]);
  const n = actions.find((a) => a.rule === 'goal-blocked');
  assert.ok(n, '应当产出阻塞通知');
  assert.equal(n.surface, true, '需要让用户在界面上看得到');
  assert.equal(n.wakeup, true);
  assert.match(n.text, /轮次额度用尽/);
  assert.match(n.text, /不要直接改目标文字/);
  assert.match(n.text, /重置成 40 轮/);
});

test('编辑目标把上限从 256 改成 40：立刻报警', () => {
  const w = createWatcher();
  const actions = run(w, [
    {
      type: 'goal/change',
      time: 1,
      data: {
        operation: 'create',
        roundsStarted: 0,
        goal: { id: 'g', revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 256 },
      },
    },
    {
      type: 'goal/change',
      time: 2,
      data: {
        operation: 'edit',
        roundsStarted: 256,
        goal: { id: 'g', revision: 2, objective: 'x2', phase: 'blocked', maxGoalRounds: 40 },
      },
    },
  ]);
  const n = actions.find((a) => a.rule === 'goal-budget-changed');
  assert.ok(n, '应当产出额度变更通知');
  assert.match(n.text, /从 256 改成了 40/);
  assert.match(n.text, /无法恢复/);
});

test('目标完成：提醒「完成改不回进行中」', () => {
  const w = createWatcher();
  const actions = run(w, [
    {
      type: 'goal/change',
      time: 1,
      data: {
        operation: 'complete',
        roundsStarted: 17,
        goal: { id: 'g', revision: 2, objective: 'x', phase: 'complete', maxGoalRounds: 256 },
      },
    },
  ]);
  const n = actions.find((a) => a.rule === 'goal-complete');
  assert.ok(n);
  assert.match(n.text, /改不回进行中/);
});

test('目标状态快照：进行中但长时间没有自动续跑会被标出来', () => {
  const w = createWatcher({ goalIdleWarnMs: 1000 });
  run(w, [
    {
      type: 'goal/change',
      time: 0,
      data: {
        operation: 'create',
        roundsStarted: 0,
        goal: { id: 'g', revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 256 },
      },
    },
  ]);
  assert.equal(w.snapshot(500).goal.kind, 'active-idle');
  assert.match(w.snapshot(500).goal.text, /尚未自动推进/);
  assert.match(w.snapshot(5000).goal.text, /尚未自动推进/);
});

test('自动续跑推进过：快照显示进行中', () => {
  const w = createWatcher({ goalIdleWarnMs: 10_000 });
  run(w, [
    {
      type: 'goal/change',
      time: 0,
      data: {
        operation: 'create',
        roundsStarted: 0,
        goal: { id: 'g', revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 256 },
      },
    },
    { type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: '<goal_round>...' }], source: { kind: 'goal' } } },
  ]);
  assert.equal(w.snapshot(2000).goal.kind, 'active');
  assert.equal(w.snapshot(20000).goal.kind, 'active-idle');
});

test('整轮失败且没有正文：合成一条给用户看的说明', () => {
  const w = createWatcher();
  const actions = run(w, [
    { type: 'turn/start', data: { turn: 9 }, time: 0 },
    {
      type: 'turn/end',
      time: 1000,
      data: { reason: { kind: 'error', error: { message: '429 AccountQuotaExceeded' } } },
    },
  ]);
  const n = actions.find((a) => a.rule === 'turn-failed-silently');
  assert.ok(n);
  assert.match(n.text, /第 9 轮失败/);
  assert.match(n.text, /AccountQuotaExceeded/);
});

test('失败但模型已经说了话：不重复播报', () => {
  const w = createWatcher();
  const actions = run(w, [
    { type: 'turn/start', data: { turn: 9 }, time: 0 },
    { type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'text', text: '我失败了，原因是……' }] } } },
    { type: 'turn/end', time: 1000, data: { reason: { kind: 'error', error: { message: 'boom' } } } },
  ]);
  assert.equal(actions.filter((a) => a.rule === 'turn-failed-silently').length, 0);
});

test('后台任务运行中会被状态条统计到', () => {
  const w = createWatcher();
  run(w, [
    { type: 'job/started', time: 0, data: { id: 'bash-1', kind: 'bash' } },
    { type: 'job/started', time: 0, data: { id: 'bash-2', kind: 'bash' } },
  ]);
  assert.equal(w.snapshot(1000).runningJobs, 2);
  run(w, [{ type: 'job/settled', time: 2000, data: { id: 'bash-1' } }]);
  assert.equal(w.snapshot(3000).runningJobs, 1);
});

test('humanDuration 说人话', () => {
  assert.equal(humanDuration(30_000), '30 秒');
  assert.equal(humanDuration(5 * 60_000), '5 分钟');
  assert.equal(humanDuration(90 * 60_000), '1 小时 30 分钟');
});

test('默认阈值互不矛盾', () => {
  assert.ok(DEFAULT_CONFIG.planStaleCooldown > DEFAULT_CONFIG.planStaleToolCalls);
});

test('沉默过久：连续 12 次工具调用没有正文就提醒一次', () => {
  const w = createWatcher();
  const actions = run(w, [
    { type: 'turn/start', data: { turn: 1 }, time: 1 },
    ...manyToolCalls(11),
  ]);
  assert.equal(actions.filter((a) => a.rule === 'silence').length, 0, '11 次还不该提醒');

  const more = run(w, manyToolCalls(1, 12));
  const s = more.filter((a) => a.rule === 'silence');
  assert.equal(s.length, 1, '第 12 次应当提醒');
  assert.equal(s[0].kind, 'remind');
  assert.equal(s[0].target, 'next-step');
  assert.equal(s[0].wakeup, false, '不该强行唤醒新轮');
  assert.match(s[0].text, /没有输出任何正文/);
  assert.match(s[0].text, /现在做到哪/);
});

test('只要说了话，沉默计时就归零', () => {
  const w = createWatcher();
  const actions = run(w, [
    { type: 'turn/start', data: { turn: 1 }, time: 1 },
    ...manyToolCalls(10),
    // 模型说了一句话
    { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: '已经做完甲，接着做乙' }] } } },
    ...manyToolCalls(10, 11),
  ]);
  assert.equal(actions.filter((a) => a.rule === 'silence').length, 0, '说完话之后不该再报沉默');
  assert.equal(w.snapshot().silentForToolCalls, 10);
});

test('沉默提醒有冷却，不会每步都刷', () => {
  const w = createWatcher();
  const actions = run(w, [
    { type: 'turn/start', data: { turn: 1 }, time: 1 },
    ...manyToolCalls(40),
  ]);
  const n = actions.filter((a) => a.rule === 'silence').length;
  // 12 次触发一次，冷却 12：在 40 次里大约触发 3 次
  assert.ok(n >= 2 && n <= 4, `40 次工具调用里的沉默提醒数量应在 2-4 次，实际 ${n}`);
});
