/**
 * dsh-harness-watchdog —— 干预决策层（纯逻辑，不依赖 DSH）。
 *
 * 和 policy.js 的分工：
 *   policy.js     看事件，决定「该提醒什么」（给模型说的话）
 *   intervene.js  看状态，决定「该不该动手」（真正去改目标、拦住收轮）
 *
 * 这里只做判断，不执行。执行在 src/index.js，因为要碰 goals 服务和 agent。
 *
 * 为什么要有这一层：用户明确要求「不要只弹提示，要干预目标和任务状态」。
 * 框架实际留了两个动手的口子（都在源码里核对过）：
 *   1. `agent/turn-stopping` 之后，只要收件箱的「下一步」非空，这一轮就不会结束
 *      —— 所以在那里 `agent.steer(...)` 能把一轮拉回来继续干。
 *   2. `goals` 服务对插件开放 `get/edit/resume`，且不校验「必须有人类直接发话」
 *      —— 所以能自动把跑满额度的目标救回来。
 */

export const DEFAULT_INTERVENE = {
  /** 目标因轮次额度用尽而停时，是否自动救回来 */
  autoRescueGoal: true,
  /** 同一个目标最多自动救几次，防止无限烧额度 */
  maxRescuesPerGoal: 3,
  /** 每次救援加多少额度：按已用轮数的一个比例，但有下限 */
  rescueGrowthRatio: 0.5,
  rescueMinRounds: 64,
  /** 额度的绝对上限，任何情况下都不越过 */
  rescueMaxRounds: 4096,
  /** 目标是「进行中但被悄悄解除武装」时，是否自动重新武装 */
  rearmDisarmedGoal: true,
  /** 同一个目标最多自动重新武装几次 */
  maxRearmsPerGoal: 5,
  /** 任务清单陈旧时，是否拦住收轮、强制模型先刷新清单 */
  forcePlanRefresh: true,
  /** 一轮里至少干了这么多次工具调用，才值得拦 */
  forcePlanMinToolCalls: 8,
  /** 距上次写清单至少这么多次工具调用，才算「清单陈旧」 */
  forcePlanStaleToolCalls: 15,
  /** 收尾对账：模型声称完成、但清单里还有未完成项时，是否拦下 */
  reconcileOnClaim: true,
  /** 判定「声称完成」用的措辞 */
  claimPatterns: [
    '全部完成', '已全部完成', '均已完成', '都已完成', '已经完成',
    '已完成', '剩余 0', '剩余0', '完成 5 项', '完成了',
  ],
};

export const DEFAULT_REASONS = {
  rescue: '轮次额度用尽被框架阻塞',
  rearm: '自动续跑被悄悄停用',
  forcePlan: '本轮有实质工作但任务清单没更新',
};

function key(goalId) {
  return String(goalId)
}

export function createIntervener(userConfig = {}) {
  const config = { ...DEFAULT_INTERVENE, ...userConfig };

  /** goalId -> 已经救过几次 */
  const rescues = new Map();
  /** goalId -> 已经重新武装过几次 */
  const rearms = new Map();
  /** goalId -> 最近一次尝试的 revision，避免同一个版本反复重试 */
  const lastAttempt = new Map();
  /** `${sessionId}:${turn}` -> 已经拦过 */
  const forcedTurns = new Set();
  const counters = { rescue: 0, rearm: 0, forcePlan: 0, skipped: 0 };

  function bump(map, k) {
    const next = (map.get(k) || 0) + 1;
    map.set(k, next);
    return next;
  }

  /**
   * 收到目标状态变化时判断要不要动手。
   * @param view - goals.get(agent) 返回的视图，字段是扁平的：
   *   { id, revision, objective, phase, maxGoalRounds, roundsStarted, activation }
   * @returns 决策，或 null 表示不动
   */
  function decideGoal(view) {
    if (!view || !view.id) return null
    const k = key(view.id)

    // 已经针对这个版本尝试过就不再重复，避免失败时打成死循环
    if (lastAttempt.get(k) === view.revision) return null

    // 一、额度用尽被写成「阻塞」：把额度改大再恢复
    if (view.phase === 'blocked') {
      const used = view.roundsStarted ?? 0
      const max = view.maxGoalRounds ?? 0
      if (used < max) return null // 真受阻，不是额度问题，不碰
      if (!config.autoRescueGoal) {
        counters.skipped += 1
        return null
      }
      if ((rescues.get(k) || 0) >= config.maxRescuesPerGoal) {
        counters.skipped += 1
        return null
      }
      const growth = Math.max(config.rescueMinRounds, Math.ceil(used * config.rescueGrowthRatio))
      const target = Math.min(used + growth, config.rescueMaxRounds)
      if (target <= max) return null // 已经到顶，救不动了
      lastAttempt.set(k, view.revision)
      return {
        kind: 'rescue',
        goalId: view.id,
        ref: { id: view.id, revision: view.revision },
        previousMaxGoalRounds: max,
        newMaxGoalRounds: target,
        usedRounds: used,
        attempt: (rescues.get(k) || 0) + 1,
        maxAttempts: config.maxRescuesPerGoal,
        reason: DEFAULT_REASONS.rescue,
      }
    }

    // 二、目标是进行中但被悄悄解除了武装：重新武装
    if (view.phase === 'active' && view.activation === 'disarmed') {
      if (!config.rearmDisarmedGoal) {
        counters.skipped += 1
        return null
      }
      if ((rearms.get(k) || 0) >= config.maxRearmsPerGoal) {
        counters.skipped += 1
        return null
      }
      lastAttempt.set(k, view.revision)
      return {
        kind: 'rearm',
        goalId: view.id,
        ref: { id: view.id, revision: view.revision },
        attempt: (rearms.get(k) || 0) + 1,
        maxAttempts: config.maxRearmsPerGoal,
        reason: DEFAULT_REASONS.rearm,
      }
    }

    return null
  }

  /** 清单里还有几项没完成 */
  function openItems(summary) {
    if (!summary || typeof summary !== 'object') return 0
    const total = Number(summary.total) || 0
    const done = Number(summary.done) || 0
    return Math.max(0, total - done)
  }

  /** 模型有没有在正文里声称做完了 */
  function claimsCompletion(text) {
    if (!text || typeof text !== 'string') return false
    return config.claimPatterns.some((p) => text.includes(p))
  }

  /**
   * 收到「这一轮即将结束」时判断要不要拦。
   * @param input - { sessionId, turn, toolCallsThisTurn, toolCallsSinceTodo, todoSummary, lastTurnText }
   */
  function decideTurnStopping(input) {
    if (!config.forcePlanRefresh) return null
    const { sessionId, turn } = input
    const thisTurn = input.toolCallsThisTurn ?? 0
    const sinceTodo = input.toolCallsSinceTodo ?? 0
    if (!sessionId || turn == null) return null

    const k = `${sessionId}:${turn}`
    if (forcedTurns.has(k)) return null

    const open = openItems(input.todoSummary)
    const claim = claimsCompletion(input.lastTurnText)

    // 规则甲（收尾对账）：清单里还有没完成的项，而模型的话里已经声称做完了。
    // 这是「任务已经结束、界面上的任务状态却没更新」的直接原因。
    if (config.reconcileOnClaim && open > 0 && claim) {
      forcedTurns.add(k)
      return {
        kind: 'forcePlan',
        reason: 'claim-mismatch',
        sessionId,
        turn,
        toolCallsThisTurn: thisTurn,
        toolCallsSinceTodo: sinceTodo,
        openItems: open,
        text:
          `【看门狗】你在这一轮的回复里声称任务已经完成，但任务清单里还有 ${open} 项没有标成完成，` +
          `界面上的任务状态会停在旧的样子。这一轮先不要结束：请立刻用 todo_write 把清单改成真实状态——` +
          `真的做完的标 completed；确实没做或有意不做的保持未完成，并在回复里说明为什么。`,
      }
    }

    // 规则乙（原有）：干了足够多的活而清单很久没更新。
    if (thisTurn < config.forcePlanMinToolCalls) return null
    if (sinceTodo < config.forcePlanStaleToolCalls) return null

    forcedTurns.add(k)
    return {
      kind: 'forcePlan',
      reason: 'stale',
      sessionId,
      turn,
      toolCallsThisTurn: thisTurn,
      toolCallsSinceTodo: sinceTodo,
      text:
        `【看门狗】本轮已经做了 ${thisTurn} 次工具调用，任务清单还没有更新。` +
        `这一轮先不要结束：请立刻用 todo_write 把清单更新到最新（完成的标 completed、` +
        `正在做的标 in_progress、剩余工作逐条列出），然后再继续或收尾。`,
    }
  }

  /** 动作成功之后记账。 */
  function noteDone(decision) {
    if (!decision) return
    if (decision.kind === 'rescue') {
      bump(rescues, key(decision.goalId))
      counters.rescue += 1
    } else if (decision.kind === 'rearm') {
      bump(rearms, key(decision.goalId))
      counters.rearm += 1
    } else if (decision.kind === 'forcePlan') {
      counters.forcePlan += 1
    }
  }

  /** 动作失败时解除「这个版本试过了」的标记，让下一轮还有机会重试。 */
  function noteFailed(decision) {
    if (decision && decision.goalId) lastAttempt.delete(key(decision.goalId))
  }

  function stats() {
    return {
      ...counters,
      goalsRescued: rescues.size,
      goalsRearmed: rearms.size,
      forcedTurns: forcedTurns.size,
      config: { ...config },
    }
  }

  return { decideGoal, decideTurnStopping, noteDone, noteFailed, stats, config }
}
