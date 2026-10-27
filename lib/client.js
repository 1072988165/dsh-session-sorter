// dsh-session-sorter — BROWSER half.
//
// A `settings.section` panel that reorders the sessions of one workspace.
// All ordering work happens in the host half (see src/index.ts); this file is
// the picker + the "switch to manual order" nudge.
//
// Why a nudge is needed: the sidebar's manual order is a browser-local list
// (`dsh.workspace.view.v5` → `sessionOrderByAccount`), seeded from the host's
// `sessionIds` when the user first switches to 手动排序. Writing the host order
// is therefore only half the job — the view mode has to be manual for it to be
// visible.
window.__ModuleLoader__.load({
  id: 'dsh-session-sorter',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-session-sorter'
    const zh = {
      nav: '会话排序',
      title: '会话排序',
      hint: '按创建时间或标题重排某个工作区里的会话。排序结果写入宿主的工作区账本，随后需切到「手动排序」视图。',
      workspace: '工作区',
      key: '排序依据',
      keyCreated: '创建时间',
      keyTitle: '标题',
      direction: '方向',
      asc: '正序（旧 → 新）',
      desc: '倒序（新 → 旧）',
      run: '执行排序',
      running: '排序中…',
      loading: '加载中…',
      loadFailed: '工作区列表加载失败',
      empty: '没有可排序的工作区',
      done: (n, moved) => `已写入 ${n} 条会话，其中 ${moved} 条位置发生变化。`,
      switchMode: '已切到「手动排序」视图，即将刷新…',
      manualHint: '接下来请点右上角「视图选项 → 排序方式 → 手动排序」，宿主顺序才会显示出来。',
      autoFailed: '无法自动切换视图模式，请手动切到「手动排序」。',
      noChange: '顺序没有变化，无需写入。',
    }
    const en = {
      nav: 'Session Sorter',
      title: 'Session Sorter',
      hint: 'Reorder the sessions of one workspace by creation time or title. The order is written to the host workspace registry; switch the view to Manual order to see it.',
      workspace: 'Workspace',
      key: 'Sort by',
      keyCreated: 'Creation time',
      keyTitle: 'Title',
      direction: 'Direction',
      asc: 'Ascending (old → new)',
      desc: 'Descending (new → old)',
      run: 'Apply order',
      running: 'Sorting…',
      loading: 'Loading…',
      loadFailed: 'Failed to load workspaces',
      empty: 'No workspace to sort',
      done: (n, moved) => `Wrote ${n} sessions, ${moved} of them moved.`,
      switchMode: 'Switched to Manual order, reloading…',
      manualHint: 'Next: 视图选项 → 排序方式 → 手动排序 to show the host order.',
      autoFailed: 'Could not switch the view mode automatically — pick Manual order yourself.',
      noChange: 'Order unchanged, nothing written.',
    }

    let t = (k) => k
    const setT = (fn) => { t = fn }

    const VIEW_KEY = 'dsh.workspace.view.v5'

    // Best-effort flip of the persisted view mode. Returns true only when we
    // actually recognised the stored shape, so a reload never happens blindly.
    function switchViewToManual() {
      try {
        const raw = window.localStorage.getItem(VIEW_KEY)
        if (raw === null) return false
        const parsed = JSON.parse(raw)
        const holder = parsed && typeof parsed === 'object'
          ? ('orderBy' in parsed ? parsed : (parsed.value && typeof parsed.value === 'object' ? parsed.value : null))
          : null
        if (holder === null) return false
        holder.orderBy = 'manual'
        if (holder.sessionOrderByAccount && typeof holder.sessionOrderByAccount === 'object') {
          holder.sessionOrderByAccount = {}
        }
        window.localStorage.setItem(VIEW_KEY, JSON.stringify(parsed))
        return true
      } catch {
        return false
      }
    }

    const S = {
      box: { padding: '4px 2px', color: 'var(--dsw-alias-label-primary, #c9d1d9)', fontFamily: 'inherit' },
      grid: { display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center', marginTop: '12px' },
      label: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #8b949e)' },
      control: {
        fontSize: '13px', padding: '6px 8px', borderRadius: '6px',
        color: 'var(--dsw-alias-label-primary, #c9d1d9)',
        background: 'var(--dsw-alias-bg-layer-1, #0d1117)',
        border: '1px solid var(--dsw-alias-border-l1, #30363d)',
        minWidth: '0',
      },
      title: { fontSize: '15px', fontWeight: 600, margin: '0 0 6px' },
      hint: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #8b949e)', margin: '0' },
      button: {
        marginTop: '14px', fontSize: '13px', padding: '7px 16px', borderRadius: '6px', cursor: 'pointer',
        border: 'none',
        background: 'var(--dsw-alias-button-primary-fill, #238636)',
        color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      },
      buttonBusy: { opacity: 0.6, cursor: 'default' },
      result: { marginTop: '12px', fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #8b949e)' },
      error: { marginTop: '12px', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #f85149)' },
    }

    function Panel() {
      const [workspaces, setWorkspaces] = useState({ status: 'loading', items: [] })
      const [workspaceId, setWorkspaceId] = useState('')
      const [key, setKey] = useState('createdAt')
      const [direction, setDirection] = useState('asc')
      const [run, setRun] = useState({ status: 'idle', message: '' })

      useEffect(() => {
        let cancelled = false
        fetch('/dsh-session-sorter/workspaces')
          .then((r) => r.json())
          .then((data) => {
            if (cancelled) return
            const items = Array.isArray(data?.workspaces) ? data.workspaces : []
            setWorkspaces({ status: 'ok', items })
            if (items.length > 0) setWorkspaceId((current) => current || items[0].id)
          })
          .catch(() => { if (!cancelled) setWorkspaces({ status: 'error', items: [] }) })
        return () => { cancelled = true }
      }, [])

      const submit = useCallback(async () => {
        if (workspaceId === '') return
        setRun({ status: 'running', message: '' })
        try {
          const response = await fetch('/dsh-session-sorter/sort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId, key, direction }),
          })
          const data = await response.json()
          if (!response.ok || data?.ok !== true) {
            setRun({ status: 'error', message: String(data?.error ?? `HTTP ${response.status}`) })
            return
          }
          if (data.moved === 0) {
            setRun({ status: 'ok', message: t('noChange') })
            return
          }
          const message = t('done')(data.total, data.moved)
          if (switchViewToManual()) {
            setRun({ status: 'ok', message: `${message} ${t('switchMode')}` })
            window.setTimeout(() => window.location.reload(), 700)
          } else {
            setRun({ status: 'ok', message: `${message} ${t('autoFailed')} ${t('manualHint')}` })
          }
        } catch (error) {
          setRun({ status: 'error', message: String(error?.message ?? error) })
        }
      }, [workspaceId, key, direction])

      const busy = run.status === 'running' || workspaces.status !== 'ok' || workspaceId === ''

      return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-session-sorter', 'data-dsh-surface': 'settings-modal' },
        h('h3', { style: S.title }, t('title')),
        h('p', { style: S.hint }, t('hint')),

        workspaces.status === 'loading' && h('p', { style: S.result }, t('loading')),
        workspaces.status === 'error' && h('p', { style: S.error }, t('loadFailed')),
        workspaces.status === 'ok' && workspaces.items.length === 0 && h('p', { style: S.result }, t('empty')),

        workspaces.status === 'ok' && workspaces.items.length > 0 && h('div', { style: S.grid },
          h('span', { style: S.label }, t('workspace')),
          h('select', {
            style: S.control,
            value: workspaceId,
            onChange: (e) => setWorkspaceId(e.target.value),
          }, workspaces.items.map((item) => h('option', { key: item.id, value: item.id },
            `${item.title ?? item.path} (${item.sessionCount})`))),

          h('span', { style: S.label }, t('key')),
          h('select', {
            style: S.control,
            value: key,
            onChange: (e) => setKey(e.target.value),
          },
            h('option', { value: 'createdAt' }, t('keyCreated')),
            h('option', { value: 'title' }, t('keyTitle'))),

          h('span', { style: S.label }, t('direction')),
          h('select', {
            style: S.control,
            value: direction,
            onChange: (e) => setDirection(e.target.value),
          },
            h('option', { value: 'asc' }, t('asc')),
            h('option', { value: 'desc' }, t('desc'))),
        ),

        h('button', {
          type: 'button',
          style: busy ? { ...S.button, ...S.buttonBusy } : S.button,
          disabled: busy,
          onClick: submit,
        }, run.status === 'running' ? t('running') : t('run')),

        run.status === 'ok' && h('p', { style: S.result }, run.message),
        run.status === 'error' && h('p', { style: S.error }, run.message),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-sorter: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-session-sorter',
            order: 70,
            label: () => bound('nav'),
            locale: NS,
          }, Panel))
        } catch (e) {
          console.error('[dsh-session-sorter] apply failed:', e)
        }
      },
    }
  },
})
