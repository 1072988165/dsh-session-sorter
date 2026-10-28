# dsh-session-sorter

DSH（DeepSeek Harness）会话排序插件：按**创建时间**或**标题**重排某个工作区里的会话，用来把导入会话后被打乱的时间线拉回正常。

A DeepSeek Harness plugin that reorders the sessions of a workspace by creation time or title.

## 它解决什么问题

导入外部会话（`dsh-chat-import` 等）之后，侧栏经常变成一团：原生会话还在，一堆导入会话挤在同一分钟，整块把你真实的时间顺序顶乱。原生只提供「最近更新 / 手动排序」两种视图，缺一个「按我想要的规则重排一次」的入口。

这个插件补的就是那一步：选一个工作区 → 选排序依据 → 点一下，侧栏立刻按这个顺序排好；想回到原生的「最近更新」排序，随时一键切回。

## 安装

```bash
# 从本地目录安装（开发态）
dsh plugin --profile desktop add /path/to/dsh-session-sorter

# 或从 npm 安装（发布后）
dsh plugin --profile desktop add dsh-session-sorter
```

装完重启 DSH Desktop，进入 **设置 → 会话排序**。

## 用法

1. 设置里打开「会话排序」面板
2. 选工作区（下拉里带该工作区的会话数）
3. 选排序依据：创建时间 / 标题
4. 选方向：正序（旧 → 新）/ 倒序（新 → 旧）
5. 点「执行排序」——面板会把这次算出的顺序写进「手动排序」，然后自动刷新
6. 想回到 DSH 原生的按更新时间排序，点同一行的「恢复「最近更新」排序」

> ⚠️ 自定义顺序是**浏览器本地**的（`localStorage` 的 `dsh.workspace.view.v5`），换机器/换浏览器不会跟随；「最近更新」视图则永远按每个会话自己的更新时间排，两者是不同视图，不是谁覆盖了谁。

## 原理

**先说关键事实**（2026-10-28 在 DSH NEXT 上逐条验证）：当前侧栏的行顺序来自宿主会话序列化器 ——

```
compareSessions(a, b) = b.header.createdAt - a.header.createdAt
```

也就是**按会话创建时间倒序**，而不是按最近更新时间。行右侧那个时间才是 `updatedAt = max(createdAt, 最后一条用户消息时间)`。
两者一旦不一致，就表现为「刚聊过的会话沉在下面、排序乱了」：导入会话、或者聊了很久的老会话都会这样。

插件因此做两件事：

**1. 顺序层（工作区账本）**

- 宿主的工作区注册表（`sessionIds` 数组）决定「哪些会话属于这个工作区」以及账本顺序。Host 半区用 `ctx.workspaceRegistry.get(id).mutate()` 一次写入 —— `@deepseek-ai/dsh-workspace` 的官方唯一写路径，不直接改文件。
- 老侧栏另有一层浏览器视图 store `dsh.workspace.view.v5`（`orderBy: "updated" | "manual"`）。「执行排序」时 Host 把算好的 `order` 一起返回，浏览器半区写进 `sessionOrderByAccount` 并切到 `manual`。
- 排序键来自 `ctx.sessionQuery.listSessions()` 的 header（`createdAt` / `title`），只读。

**2. 时间层（当前侧栏真正生效的一层）**

Host 半区在启动 8 秒后跑一次 `src/maintenance.ts` 的 `syncCreatedAt()`，把每个会话日志 header 的 `createdAt` 同步成它的最后活动时间：

- 只处理 `updatedAt - createdAt > 60s` 的会话，正常启动是空操作；
- 跳过 3 分钟内还在写入的日志（避免打断正在进行的会话）；
- 每个 `.zstd` 日志：解压 → 只改第一行 header 的 `createdAt` → 重新压缩 → 原子替换；
- 改之前把原值写进 `~/.dsh/dsh-session-sorter/created-at-origins.jsonl` 作为审计痕迹；
- 失败只计数、不抛出，不会阻塞启动；
- `DSH_SESSION_SORTER_SYNC_CREATED=0` 可关闭。

## 边界与已知限制

- 只排序**当前工作区**的会话，不跨工作区搬动。
- 已归档会话保留它在 `sessionIds` 里的槽位（原生设计），排序时一并参与。
- 日志缺失、列表里查不到的会话不参与排序，但也不会被丢弃 —— 保持原相对顺序排到末尾。
- 时间层会**改写日志 header 的 `createdAt`**（仅这一行、仅这一个字段）。这是在「侧栏按 createdAt 排序」这一当前行为下，让顺序跟上更新时间的唯一手段；原值可在上面那份审计文件里找回。
- 时间层在一轮启动内只跑一次：本次运行中又续聊的老会话，会在**下次启动**被挪到正确位置。

## 开发

```bash
pnpm install
pnpm run build     # 编译 Host 半区到 dist/
pnpm test          # 纯函数单测
```

结构：

```
src/index.ts     Host 半区：HTTP 路由 + 排序逻辑
lib/client.js    浏览器半区：settings.section 面板
cordis.patch.yml 插件装载补丁
```

## License

MIT
