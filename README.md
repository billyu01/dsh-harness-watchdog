# dsh-harness-watchdog

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个宿主端插件：**盯住长任务的执行节奏**。

跑长任务时，agent 容易一连调用几十上百次工具、中途一个字都不输出，用户只能在屏幕前干等；它也可能不主动拆解、不写任务清单。这个插件用 DSH 官方钩子把这几件事管起来，**不修改会话记录、不阻止工具调用、不接管界面**。

## 它做什么

| 规则 | 触发条件 | 动作 | 使用的钩子 |
|---|---|---|---|
| **沉默过久** | 连续 12 次工具调用没有任何正文 | 注入提醒，要求说明「做到哪、还剩什么、为什么还没结束」 | `tools/post-execute` |
| **计划陈旧** | 距上次写任务清单 ≥ 15 次工具调用（且全会话已 ≥ 20 次） | 注入提醒，要求用 `todo_write` 重写清单 | `tools/post-execute` |
| **拦收轮（硬干预）** | 本轮已 ≥ 8 次工具调用、清单已 ≥ 15 次没更新，且这一轮即将结束 | 用 `agent.steer()` 把这一轮拉回来，清单不刷新就不让它结束 | `agent/turn-stopping` |
| **单轮过长** | 单轮 ≥ 60 步 | 提醒一次，要求先汇报再继续 | `tools/post-execute` |
| **目标自动救援** | 目标因**轮次额度用尽**被框架写成「阻塞」 | 自动把额度改大再恢复，同一目标最多 3 次 | `goals` 服务 `edit` / `resume` |
| **目标自动重新武装** | 目标「进行中」但自动续跑被悄悄停用 | 自动重新开启，同一目标最多 5 次 | `goals` 服务 `resume` |

提醒只往模型上下文里追加一段合成用户消息，**不会改动会话日志**。

## 安装

要求：DSH 0.2.x，profile 机制可用的环境。

### 方式一：从 GitHub 安装（推荐）

在 DSH profile 目录执行：

```bash
cd ~/.dsh/profiles/<你的 profile 名>

# 1. 加依赖。两个参数必须带：
#    --config.auto-install-peers=false ：DSH profile 不自动安装 peer 依赖；
#        漏掉会去公共 registry 找 @deepseek-ai/* 那些不公开的包，直接 404 失败。
#    --config.node-linker=hoisted      ：DSH profile 用的是扁平布局；
#        漏掉会把包装进 .pnpm 隔离目录，插件解析不到。
pnpm add -w github:billyu01/dsh-harness-watchdog \
  --config.auto-install-peers=false \
  --config.node-linker=hoisted

# 2. 在 package.json 的 dsh.profile.bundles 里加上这个名字
#    "dsh.profile.bundles": [ ..., "dsh-harness-watchdog" ]
```

> 这两个参数是 Profile 的既定约定，不是本插件的特殊要求。改完 `dsh.profile.bundles`
> 后 DSH 会重新组合插件，通常不用重启进程。

包自带 `dsh.bundle.patch`，出现在 `dsh.profile.bundles` 后 DSH 会自动应用挂载行，不需要手工改 `cordis.patch.yml`。

也可以直接在 DSH 的**侧边栏 → 插件**页里安装，来源填本地目录或仓库地址。

### 方式二：手工挂载

如果你的 DSH 版本不支持组合包，把包放到能解析的位置，然后在 profile 的 `cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: harness-watchdog
      name: dsh-harness-watchdog
```

## 停用

- **设置里关**：侧边栏 → 插件 → 找到 `harness-watchdog` → 关掉。立即生效，不用重启。
- **配置总开关**：在挂载行上加 `config: { enabled: false }`，插件加载但完全不工作。
- **卸载**：插件页删除，或从 `dsh.profile.bundles` 与依赖里移除。

## 验证

```bash
# 单元与集成测试（54 个用例，不依赖真实 DSH）
node --test test/policy.test.mjs test/intervene.test.mjs test/host.test.mjs

# 装载后查看状态（默认端口 3080；桌面版端口以实际为准）
curl -s http://127.0.0.1:3080/harness-watchdog/status | head -c 400
# 返回里没有 version 字段说明跑的还是旧模块，需要重启
```

## 调阈值

`src/policy.js` 的 `DEFAULT_CONFIG` 与 `src/intervene.js` 的 `DEFAULT_INTERVENE`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `silenceToolCalls` | 12 | 连续多少次工具调用没正文就提醒 |
| `silenceCooldown` | 12 | 两次沉默提醒的最小间隔 |
| `planStaleToolCalls` / `planStaleCooldown` | 15 / 30 | 清单陈旧阈值与冷却 |
| `longTurnSteps` | 60 | 单轮步数提醒阈值 |
| `forcePlanMinToolCalls` / `forcePlanStaleToolCalls` | 8 / 15 | 拦收轮的门槛 |
| `maxRescuesPerGoal` / `maxRearmsPerGoal` | 3 / 5 | 目标干预次数上限 |
| `rescueMaxRounds` | 4096 | 轮次额度绝对上限 |

也可以整体关掉干预：

```js
apply(ctx, { intervene: { autoRescueGoal: false, rearmDisarmedGoal: false, forcePlanRefresh: false } })
```

## 钩子契约（改代码前必读）

DSH 的钩子分三种，注册错会让整个会话崩掉：

| 类型 | 注册方式 | 约定 |
|---|---|---|
| broadcast | `ctx.on(名字, (载荷) => void)` | 返回值被忽略 |
| serial | `ctx.on(名字, async (载荷) => void)` | 顺序执行，返回值被忽略 |
| waterfall | `ctx.on(名字, (载荷..., next) => next())` | **必须调用 `next()` 并把结果交回去** |

`src/index.js` 顶部的 `HOOK_CONTRACT` 表是唯一真源。曾经因为把 `agent/pre-step`（waterfall）当普通监听器注册，导致每一轮第一步就报 `Cannot read properties of undefined (reading 'kind')`；`test/host.test.mjs` 末尾有专门的契约回归用例。

### 兼容性规则

1. 注册钩子前先核对契约；
2. 瀑布式只交回下游决策，下游不是对象时原样返回；
3. 调 `goals.*`、`agent.steer` 前做能力探测；
4. 每个监听器体包 `try/catch`；
5. 连续 5 次内部错误自动熔断停手；
6. 契约回归测试不许删。

## 已知边界

- **提醒是建议，不是强制。** 只有「拦收轮」是真的阻止这一轮结束。
- **看不到「解除武装」本身**（该状态只存在宿主内存里），只能从「目标进行中但很久没有自动推进」推断。
- 插件在宿主进程内运行，异常一律吞掉并记警告。

## 许可

MIT
