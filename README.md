# dsh-harness-watchdog

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个宿主端插件：**盯住长任务的执行节奏**。

跑长任务时，agent 容易一连调用几十上百次工具、中途一个字都不输出，用户只能在屏幕前干等；它也可能不主动拆解、不写任务清单。这个插件用 DSH 官方钩子把这几件事管起来，**不修改会话记录、不阻止工具调用、不接管界面**。

## 它做什么

| 规则 | 触发条件 | 动作 | 使用的钩子 |
|---|---|---|---|
| **沉默过久** | 连续 12 次工具调用没有任何正文 | 注入提醒，要求说明「做到哪、还剩什么、为什么还没结束」 | `tools/post-execute` |
| **计划陈旧** | 距上次写任务清单 ≥ 15 次工具调用（且全会话已 ≥ 20 次） | 注入提醒，要求用 `todo_write` 重写清单 | `tools/post-execute` |
| **拦收轮（硬干预）** | 本轮已 ≥ 8 次工具调用、清单已 ≥ 15 次没更新，且这一轮即将结束 | 用 `agent.steer()` 把这一轮拉回来，清单不刷新就不让它结束 | `agent/turn-stopping` |
| **收尾对账（硬干预）** | 模型在回复里**声称任务已完成**，但任务清单里还有未完成项 | 拦下这一轮，要求把清单改成真实状态；确实没做/有意不做的保持未完成并说明原因 | `agent/turn-stopping` |
| **单轮过长** | 单轮 ≥ 60 步 | 提醒一次，要求先汇报再继续 | `tools/post-execute` |
| **目标自动救援** | 目标因**轮次额度用尽**被框架写成「阻塞」 | 自动把额度改大再恢复，同一目标最多 3 次 | `goals` 服务 `edit` / `resume` |
| **目标自动重新武装** | 目标「进行中」但自动续跑被悄悄停用 | 自动重新开启，同一目标最多 5 次 | `goals` 服务 `resume` |

提醒只往模型上下文里追加一段合成用户消息，**不会改动会话日志**。

## 安装

要求：DSH 0.2.x 或更新版本，插件页可用。

### 方式一：在插件页安装（推荐）

1. 打开**侧边栏 → 插件 → 添加插件**。
2. 在「包名或地址」里填入本仓库地址：

   ```
   https://github.com/billyu01/dsh-harness-watchdog
   ```

   填 pnpm 的等价写法 `github:billyu01/dsh-harness-watchdog` 也可以。
3. 点「安装」，等进度条跑完。

装完 DSH 会自己做完三件事：把包下载进当前 profile 的依赖、把包名写进
`dsh.profile.bundles`、应用包内自带的挂载行。不用手工改 `package.json`，
也不用手工改 `cordis.patch.yml`。页面如果提示需要重启，重启一次 DSH 就好。

> 「安装源」那一栏只在输入 npm 包名时才起作用，填 GitHub 地址时用不上。

### 方式二：用 DSH 命令安装

不方便用界面时，用 DSH 自带的命令，它和插件页走同一套安装逻辑：

```bash
dsh plugin --profile desktop add github:billyu01/dsh-harness-watchdog
```

`desktop` 换成你自己的 profile 名，也就是 `~/.dsh/profiles/` 下的目录名。

### 方式三：手工挂载（旧版本兜底）

如果 DSH 版本既没有插件页，也不支持组合包，把包放到能解析的位置，再在 profile 的
`cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: harness-watchdog
      name: dsh-harness-watchdog
```

> 旧版文档要求手工 `pnpm add` 时带 `--config.auto-install-peers=false` 和
> `--config.node-linker=hoisted` 两个参数。这两个设置现在由 DSH 初始化 profile 时
> 自己写进 `pnpm-workspace.yaml`，无论走插件页还是 `dsh plugin add` 都不用再传。

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
| `reconcileOnClaim` / `claimPatterns` | 开 / 内置措辞 | 收尾对账：判定「声称完成」的开关与措辞 |
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
