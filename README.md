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

侧栏顺序其实有**两个**来源，两边都要写：

- 宿主的工作区注册表（`sessionIds` 数组）决定「哪些会话属于这个工作区」以及它们的账本顺序。Host 半区用 `ctx.workspaceRegistry.get(id).mutate()` 一次写入 —— `@deepseek-ai/dsh-workspace` 的官方唯一写路径，不直接改文件、不绕过校验。
- 真正决定**显示顺序**的是浏览器视图 store `dsh.workspace.view.v5`：
  - `orderBy: "updated"` → 按 `updatedAt = max(createdAt, 最后一条人类消息时间)` 倒序，忽略任何已保存顺序；
  - `orderBy: "manual"` → 按 `sessionOrderByAccount[workspaceId]` 里那份 id 列表。
- 所以「执行排序」时，Host 算好顺序后把 `order` 一起返回，浏览器半区把它写进 `sessionOrderByAccount` 并把 `orderBy` 切成 `manual`。只写宿主、或者写一个空顺序，界面都不会变 —— 这正是早期版本「点了没反应」的原因。
- 排序键来自 `ctx.sessionQuery.listSessions()` 的会话 header（`createdAt` / `title`），只读。

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
