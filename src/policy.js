/**
 * dsh-harness-watchdog —— 纯逻辑层
 *
 * 这一层不依赖 DSH 的任何接口，只做一件事：吃会话事件，吐「该做什么」。
 * 这样它可以脱离 harness 单独跑测试，也方便以后替换提醒策略。
 *
 * 观测输入是 DSH 会话日志里的原始记录（形如 { type, data, time, seq }），
 * 输出是一组动作（action），由 host 半负责执行。
 */

export const DEFAULT_CONFIG = {
  /** 连续多少次工具调用没有任何正文就提醒（解决「闷头跑很久不出声」） */
  silenceToolCalls: 20,
  /** 两次沉默提醒之间至少间隔多少次工具调用，避免刷屏 */
  silenceCooldown: 20,
  /** 距上次写任务清单多少步工具调用后，开始提醒 */
  planStaleToolCalls: 15,
  /** 全会话工具调用少于此数不提醒，避免打扰简单任务 */
  planStaleMinToolCalls: 20,
  /** 两次计划提醒之间至少间隔多少步工具调用，避免刷屏 */
  planStaleCooldown: 30,
  /** 单轮步数超过此值提醒一次 */
  longTurnSteps: 60,
  /**
   * 上下文膨胀的真正大头不是「提醒次数」本身，而是每次提醒都要求模型
   * 写一段进展汇报。所以策略是：提醒频率保持原样（用户等着看进展），
   * 但同一轮里同类提醒不重复刷、每条只要求一句话。
   * 下面四个上限防止「一轮里同一件事反复催」。
   */
  maxSilencePerTurn: 30,
  maxPlanPerTurn: 3,
  maxLongTurnPerTurn: 1,
  /** 每轮软提醒总闸（三类相加），防止三条规则在同一轮里叠加刷屏 */
  maxSoftRemindersPerTurn: 40,
  /**
   * 每个会话软提醒总量兜底。取 240 是为了让 2000 次工具调用级别的长任务
   * 基本保持原来的提醒频率（每 10 到 15 次一次），又给极端会话封顶。
   */
  maxSoftRemindersPerSession: 240,
  /** 收尾对账：模型说做完了但清单还有未完成项时，拦下并要求更新清单 */
  reconcileOnClaim: true,
  /** 保存最近一段正文的最大长度（用于判断「是否声称完成」） */
  lastTextLimit: 800,
  /** 已用轮数达到上限的多少比例时预警 */
  goalBudgetWarnRatio: 0.8,
  /** 判定「自动续跑可能已停」的静默时长（毫秒） */
  goalIdleWarnMs: 10 * 60 * 1000,
  /** 后台等待上限（毫秒），达到上限的 waitTruncationRatio 即视为被削平 */
  maxWaitTimeoutMs: 600000,
  waitTruncationRatio: 0.95,
};

const TOOL_NAMES_IN_WAIT = new Set(['job_output']);

/** 把毫秒时间戳转成「N 分钟前」这类中文短语 */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分钟` : `${h} 小时`;
}

/** 从事件里取出用户通道消息的来源类型 */
function sourceKind(record) {
  const src = (record.data && record.data.source) || {};
  return src.kind || 'user';
}

/** 事件里的文本，供判断 assistant 是否真的说了话 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text || '')
    .join('');
}

export function createWatcher(userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const actions = [];

  const state = {
    turn: 0,
    step: 0,
    toolCalls: 0,
    toolCallsSinceTodo: 0,
    todoWritten: false,
    todoSummary: null,
    lastPlanReminderAtToolCalls: null,
    longTurnRemindedTurn: null,
    planReminderCount: 0,
    longTurnReminderCount: 0,
    /** 本轮最后一段正文，用于收尾对账 */
    lastTurnText: '',
    /** 沉默检测：最近一次输出正文时的工具调用计数 / 最近一次沉默提醒的计数 */
    lastTextAtToolCalls: 0,
    lastSilenceReminderAtToolCalls: null,
    silenceReminderCount: 0,
    /** 本轮 / 本会话已经发出的软提醒条数（上下文膨胀的总闸门） */
    softRemindersThisTurn: 0,
    softRemindersTotal: 0,
    /** 本轮按规则分别记数，防止沉默提醒把清单提醒挤掉 */
    softThisTurnByRule: {},
    /** 目标 */
    goal: null,
    lastGoalRoundAt: null,
    goalNoticeForRevision: null,
    /** 后台任务 */
    jobs: new Map(),
    /** 当前轮次 */
    turnStartedAt: null,
    turnHadText: false,
    toolCallsThisTurn: 0,
  };

  function push(action) {
    actions.push(action);
    return action;
  }

  /** 每类软提醒在一轮里的上限，取不到就不额外限制 */
  const RULE_TURN_LIMIT = {
    silence: 'maxSilencePerTurn',
    'plan-stale': 'maxPlanPerTurn',
    'long-turn': 'maxLongTurnPerTurn',
  };

  /**
   * 发一条「软提醒」（沉默 / 清单陈旧 / 单轮过长）。
   *
   * 设计取舍：提醒频率本身不降（用户要在长任务里看到进展），成本靠三件事压：
   *   1. 同类提醒一轮里不重复刷（沉默 4 次以内、清单和单轮过长各 1 次）；
   *   2. 三类相加还有总闸，避免叠加；
   *   3. 文案要求模型「一句话」作答，削减它引发的回应长度（这才是膨胀大头）。
   * 超出上限时静默丢弃，不改变已经发生的工具执行。
   */
  function pushSoft(action) {
    const limitKey = RULE_TURN_LIMIT[action.rule];
    const ruleLimit = limitKey ? config[limitKey] : Infinity;
    const used = state.softThisTurnByRule[action.rule] || 0;
    if (used >= ruleLimit) return null;
    if (state.softRemindersThisTurn >= config.maxSoftRemindersPerTurn) return null;
    if (state.softRemindersTotal >= config.maxSoftRemindersPerSession) return null;
    state.softThisTurnByRule[action.rule] = used + 1;
    state.softRemindersThisTurn += 1;
    state.softRemindersTotal += 1;
    return push(action);
  }

  function goalStatus(now) {
    const g = state.goal;
    if (!g) return { kind: 'none', text: '无目标' };
    const used = g.roundsStarted ?? 0;
    const max = g.maxGoalRounds ?? null;
    const budget = max == null ? `${used} 轮` : `${used}/${max} 轮`;
    if (g.phase === 'blocked') {
      const exhausted = max != null && used >= max;
      return {
        kind: 'blocked',
        text: exhausted
          ? `已阻塞（轮次额度用尽 ${budget}）`
          : `已阻塞（${budget}）`,
        exhausted,
        budget,
      };
    }
    if (g.phase === 'paused') return { kind: 'paused', text: `已暂停（${budget}）`, budget };
    if (g.phase === 'complete') return { kind: 'complete', text: `已完成（${budget}）`, budget };
    if (g.phase === 'active') {
      const idle = state.lastGoalRoundAt ? now - state.lastGoalRoundAt : null;
      if (state.lastGoalRoundAt == null) {
        return { kind: 'active-idle', text: `进行中（${budget}，尚未自动推进）`, budget };
      }
      if (idle != null && idle > config.goalIdleWarnMs) {
        return {
          kind: 'active-idle',
          text: `进行中，但自动续跑已静默 ${humanDuration(idle)}`,
          budget,
          idleMs: idle,
        };
      }
      return { kind: 'active', text: `进行中（${budget}）`, budget };
    }
    return { kind: 'unknown', text: `状态 ${g.phase}`, budget };
  }

  function observe(record) {
    actions.length = 0;
    if (!record || typeof record !== 'object') return actions;
    const { type, data = {}, time } = record;
    const now = typeof time === 'number' ? time : Date.now();

    switch (type) {
      case 'turn/start': {
        state.turn = data.turn ?? state.turn + 1;
        state.step = 0;
        state.turnStartedAt = now;
        state.turnHadText = false;
        state.lastTurnText = '';
        state.toolCallsThisTurn = 0;
        state.softRemindersThisTurn = 0;
        state.softThisTurnByRule = {};
        break;
      }

      case 'compaction/start': {
        // 会话压缩后，上下文里的旧内容已经不在了，旧的调用计数也不再代表
        // 「用户已经等了多久」。把三个计时基准对齐到当前计数，避免压缩刚结束
        // 就按旧账补一条提醒；之后要重新攒够阈值才会再提醒。
        state.lastTextAtToolCalls = state.toolCalls;
        state.lastSilenceReminderAtToolCalls = state.toolCalls;
        state.lastPlanReminderAtToolCalls = state.toolCalls;
        break;
      }

      case 'step/start': {
        state.step = data.step ?? state.step + 1;
        break;
      }

      case 'assistant/message': {
        const msg = data.message || {};
        if (textOf(msg.content).trim()) {
          state.turnHadText = true;
          // 只要模型说了话，沉默计时就归零
          state.lastTextAtToolCalls = state.toolCalls;
          // 记下本轮最后一段正文，收尾时要拿它和清单对账
          state.lastTurnText = textOf(msg.content).slice(-config.lastTextLimit);
        }
        break;
      }

      case 'todo/write': {
        const todos = Array.isArray(data.todos) ? data.todos : [];
        state.todoWritten = true;
        state.toolCallsSinceTodo = 0;
        const done = todos.filter((t) => t.status === 'completed').length;
        const doing = todos.filter((t) => t.status === 'in_progress').length;
        state.todoSummary = { total: todos.length, done, doing };
        break;
      }

      case 'tool/call': {
        const name = data.name || '';
        state.toolCalls += 1;
        state.toolCallsSinceTodo += 1;
        state.toolCallsThisTurn += 1;

        // 规则零：沉默过久——连续多次工具调用没有任何正文
        // 这是「长任务闷头跑很久、用户什么都看不到」的直接对策。
        const silentFor = state.toolCalls - state.lastTextAtToolCalls;
        const silenceCooled =
          state.lastSilenceReminderAtToolCalls == null ||
          state.toolCalls - state.lastSilenceReminderAtToolCalls >= config.silenceCooldown;
        if (silentFor >= config.silenceToolCalls && silenceCooled) {
          state.lastSilenceReminderAtToolCalls = state.toolCalls;
          const sent = pushSoft({
            kind: 'remind',
            rule: 'silence',
            target: 'next-step',
            wakeup: false,
            turn: state.turn,
            text: `【看门狗】你已经连续 ${silentFor} 次工具调用没有输出任何正文。请用一句话（40 字内）说明现在做到哪，然后继续。`,
          });
          if (sent) state.silenceReminderCount += 1;
        }

        // 规则一：任务清单陈旧
        const everEnough = state.toolCalls >= config.planStaleMinToolCalls;
        const stale = state.toolCallsSinceTodo >= config.planStaleToolCalls;
        const cooled =
          state.lastPlanReminderAtToolCalls == null ||
          state.toolCalls - state.lastPlanReminderAtToolCalls >= config.planStaleCooldown;
        if (everEnough && stale && cooled) {
          state.lastPlanReminderAtToolCalls = state.toolCalls;
          const intro = state.todoWritten
            ? `任务清单已经 ${state.toolCallsSinceTodo} 次工具调用没有更新`
            : `这个会话还没有写过任务清单`;
          const sent = pushSoft({
            kind: 'remind',
            rule: 'plan-stale',
            target: 'next-step',
            wakeup: false,
            turn: state.turn,
            text: `【看门狗】${intro}（当前第 ${state.step} 步）。请用 todo_write 刷新清单：完成标 completed、在做的标 in_progress，一条一行。`,
          });
          if (sent) state.planReminderCount += 1;
        }

        // 规则二：单轮过长
        if (state.step >= config.longTurnSteps && state.longTurnRemindedTurn !== state.turn) {
          state.longTurnRemindedTurn = state.turn;
          const sent = pushSoft({
            kind: 'remind',
            rule: 'long-turn',
            target: 'next-step',
            wakeup: false,
            turn: state.turn,
            text: `【看门狗】本轮已经走到第 ${state.step} 步。请用一句话说明现在做到哪、还剩什么、下一步做什么，然后继续。`,
          });
          if (sent) state.longTurnReminderCount += 1;
        }

        // 记录后台任务启动（bash 的 background 形式等交给 host 半补充）
        if (data.jobId) {
          state.jobs.set(data.jobId, { id: data.jobId, startedAt: now, status: 'running' });
        }
        break;
      }

      case 'tool/result': {
        const msg = data.message || {};
        const callId = data.callId || msg.toolCallId;
        const payload = textOf(msg.content);
        // 规则三：后台等待被上限削平
        if (typeof callId === 'string' && /\[status: running\]/.test(payload)) {
          const job = matchJob(payload);
          if (job) state.jobs.set(job.id, { ...(state.jobs.get(job.id) || { id: job.id }), status: 'running' });
        }
        break;
      }

      case 'job/started': {
        if (data.id) {
          state.jobs.set(data.id, { id: data.id, kind: data.kind || '', startedAt: now, status: 'running' });
        }
        break;
      }

      case 'job/settled': {
        if (data.id) state.jobs.delete(data.id);
        break;
      }

      case 'goal/change': {
        const op = data.operation;
        const goal = data.goal || null;
        const prevMax = state.goal && state.goal.maxGoalRounds != null ? state.goal.maxGoalRounds : null;
        state.goal = goal
          ? {
              id: goal.id,
              revision: goal.revision,
              objective: goal.objective,
              phase: goal.phase,
              maxGoalRounds: goal.maxGoalRounds ?? null,
              roundsStarted: data.roundsStarted ?? 0,
              roundsStartedAtChange: data.roundsStarted ?? 0,
            }
          : null;

        const st = goalStatus(now);

        if (op === 'block' || (goal && goal.phase === 'blocked')) {
          if (state.goalNoticeForRevision !== `${goal.id}:${goal.revision}`) {
            state.goalNoticeForRevision = `${goal.id}:${goal.revision}`;
            push({
              kind: 'notify',
              rule: 'goal-blocked',
              target: 'next-turn',
              wakeup: true,
              surface: true,
              text:
                `【看门狗】目标已被框架停掉：${st.text}。` +
                (st.exhausted
                  ? `\n原因：轮次额度用尽（框架把「额度用完」直接写成了「阻塞」）。` +
                    `\n注意：不要直接改目标文字——那会把轮次上限静默重置成 40 轮，然后报「额度已耗尽」。` +
                    `\n正确做法：先把 max_goal_rounds 明确改大（要 ≥ 已用轮数），再恢复目标。`
                  : `\n恢复方式：先确认剩余额度，再执行恢复。`),
            });
          }
        }

        if (op === 'pause' || (goal && goal.phase === 'paused')) {
          push({
            kind: 'notify',
            rule: 'goal-paused',
            target: 'next-turn',
            wakeup: true,
            surface: true,
            text: `【看门狗】目标已暂停（${st.budget}）。需要继续时请明确说一句恢复。`,
          });
        }

        if (op === 'complete' || (goal && goal.phase === 'complete')) {
          push({
            kind: 'notify',
            rule: 'goal-complete',
            target: 'next-turn',
            wakeup: false,
            surface: true,
            text:
              `【看门狗】目标已被标记完成（${st.budget}）。` +
              `如果实际还有没做完的事，请新建一个目标并把剩余项写进去——已标记完成的目标改不回进行中。`,
          });
        }

        // 规则四：编辑动作悄悄改动了轮次上限（实测会把 256 重置成 40）
        if (op === 'edit' && goal) {
          const before = prevMax;
          const after = goal.maxGoalRounds ?? null;
          const used = data.roundsStarted ?? 0;
          if (before != null && after != null && before !== after) {
            push({
              kind: 'notify',
              rule: 'goal-budget-changed',
              target: 'next-step',
              wakeup: false,
              surface: true,
              text:
                `【看门狗】这次编辑目标把轮次上限从 ${before} 改成了 ${after}` +
                `（当前已用 ${used} 轮）。` +
                (after <= used
                  ? '新上限不高于已用轮数，目标将无法恢复——请立刻把上限改大。'
                  : '如果这不是你想要的，请手动改回去。'),
            });
          }
        }
        break;
      }

      case 'turn/end': {
        const reason = (data.reason && data.reason.kind) || '';
        if (reason === 'error' && !state.turnHadText) {
          const err = (data.reason && data.reason.error) || {};
          push({
            kind: 'notify',
            rule: 'turn-failed-silently',
            target: 'next-turn',
            wakeup: false,
            surface: true,
            text:
              `【看门狗】第 ${state.turn} 轮失败了，而对话里没有任何说明。` +
              `原因：${err.message ? String(err.message).slice(0, 300) : reason}。`,
          });
        }
        if (state.turnStartedAt && now - state.turnStartedAt > 30 * 60 * 1000) {
          push({
            kind: 'notify',
            rule: 'turn-too-long',
            target: 'next-turn',
            wakeup: false,
            surface: true,
            text: `【看门狗】第 ${state.turn} 轮跑了 ${humanDuration(now - state.turnStartedAt)}，建议下次拆小。`,
          });
        }
        break;
      }

      case 'user/message': {
        if (sourceKind(record) === 'goal') state.lastGoalRoundAt = now;
        break;
      }

      default:
        break;
    }

    return actions;
  }

  function matchJob(text) {
    const m = /(?:job|任务)\s*([a-z]+-\d+)/i.exec(text) || /([a-z]+-\d+)/i.exec(text);
    return m ? { id: m[1] } : null;
  }

  /** 供状态条使用的快照 */
  function snapshot(now = Date.now()) {
    const gs = goalStatus(now);
    const running = [...state.jobs.values()];
    return {
      turn: state.turn,
      step: state.step,
      toolCalls: state.toolCalls,
      toolCallsSinceTodo: state.toolCallsSinceTodo,
      toolCallsThisTurn: state.toolCallsThisTurn,
      todoWritten: state.todoWritten,
      todoSummary: state.todoSummary,
      lastTurnText: state.lastTurnText,
      planReminderCount: state.planReminderCount,
      longTurnReminderCount: state.longTurnReminderCount,
      silenceReminderCount: state.silenceReminderCount,
      softRemindersThisTurn: state.softRemindersThisTurn,
      softRemindersTotal: state.softRemindersTotal,
      silentForToolCalls: state.toolCalls - state.lastTextAtToolCalls,
      turnElapsedMs: state.turnStartedAt ? now - state.turnStartedAt : 0,
      goal: gs,
      goalObjective: state.goal ? state.goal.objective : null,
      goalId: state.goal ? state.goal.id : null,
      goalRevision: state.goal ? state.goal.revision : null,
      lastGoalRoundAgoMs: state.lastGoalRoundAt ? now - state.lastGoalRoundAt : null,
      runningJobs: running.length,
      jobs: running.map((j) => ({ id: j.id, kind: j.kind, runningForMs: now - (j.startedAt || now) })),
    };
  }

  return { observe, snapshot, state, config };
}
