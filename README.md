# dsh-session-sorter

DSH（DeepSeek Harness）会话排序插件：按**创建时间**或**标题**重排某个工作区里的会话，用来把导入会话后被打乱的时间线拉回正常。

A DeepSeek Harness plugin that reorders the sessions of a workspace by creation time or title.

## 它解决什么问题

导入外部会话（`dsh-chat-import` 等）之后，侧栏经常变成一团：原生会话还在，一堆导入会话挤在同一分钟，整块把你真实的时间顺序顶乱。原生只提供「最近更新 / 手动排序」两种视图，缺一个「按我想要的规则重排一次」的入口。

这个插件补的就是那一步：选一个工作区 → 选排序依据 → 点一下，顺序写回宿主的工作区账本。

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
5. 点「执行排序」
6. 面板会尝试自动把视图切到「手动排序」并刷新；如果没切成功，点右上角 **视图选项 → 排序方式 → 手动排序**

> ⚠️ 必须切到「手动排序」才看得见结果。「最近更新」视图永远按最后提示词时间排，会忽略你写入的顺序 —— 这是原生行为，不是插件 bug。

## 原理

- 会话顺序存在宿主的工作区注册表里（`sessionIds` 数组，durable）。
- Host 半区通过 `ctx.workspaceRegistry.get(id).mutate()` 一次写入整个顺序 —— 这是 `@deepseek-ai/dsh-workspace` 的官方唯一写路径，不直接改文件、不绕过校验。
- 排序键来自 `ctx.sessionQuery.listSessions()` 的会话 header（`createdAt` / `title`），只读。
- 浏览器半区只负责选参数、调 HTTP 路由、把视图模式切到 manual。

## 边界与已知限制

- 只排序**当前工作区**的会话，不跨工作区搬动。
- 已归档会话保留它在 `sessionIds` 里的槽位（原生设计），排序时一并参与。
- 日志缺失、列表里查不到的会话不参与排序，但也不会被丢弃 —— 它们保持原相对顺序排到末尾。
- 排序 ≠ 改时间戳。本插件不修改任何会话日志，纯顺序操作，可反复执行。

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
