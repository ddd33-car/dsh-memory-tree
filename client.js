/**
 * Browser half of the memory-tree dock.
 *
 * Two halves of one entry point:
 *  - `conversation.session.header.actions` carries the chip beside the session title.
 *  - `main` (key `memory-tree`) carries the page itself, so the chip switches the
 *    centre panel instead of opening a browser tab: the Desktop shell blocks
 *    `window.open`/`target=_blank`, and a same-origin iframe always works.
 *
 * The panel owns a slim toolbar because the page's own close button sits in the
 * window's top-right corner, inside the Desktop drag region, and because the page
 * must never be a one-way door.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-tree',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-memory-tree'
    const PAGE_PATH = '/memory-tree'
    const REFRESH_PATH = '/memory-tree/refresh'
    const REFRESH_HEADER = 'x-dsh-memory-tree'
    const PANEL_ID = 'memory-tree'
    const HOME_PANEL = 'conversation'

    const zh = {
      open: '记忆之树',
      hint: '打开记忆之树：一整年的记忆长成的一棵树',
      title: '记忆之树',
      back: '返回对话',
      popout: '新窗口',
      refresh: '刷新',
      refreshing: '刷新中…',
      refreshFailed: '刷新失败',
    }

    const en = {
      open: 'Memory tree',
      hint: 'Open the memory tree page',
      title: 'Memory tree',
      back: 'Back to chat',
      popout: 'New window',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      refreshFailed: 'Refresh failed',
    }

    const CSS = `
.dshtree_btn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;text-decoration:none;transition:background .15s ease,color .15s ease}
.dshtree_btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit)}
.dshtree_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
.dshtree_icon{display:block;flex:none}
.dshtree_label{display:block}
.dshtree_page{display:flex;flex-direction:column;height:100%;min-height:72vh;background:#07090a}
.dshtree_bar{display:flex;align-items:center;gap:8px;flex:none;height:36px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));background:var(--dsw-alias-bg-base,#0d1013);-webkit-app-region:no-drag}
.dshtree_bar_button{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:background .15s ease,color .15s ease}
.dshtree_bar_button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit)}
.dshtree_bar_title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}
.dshtree_frame{flex:1 1 auto;width:100%;border:0;display:block;min-height:68vh;background:#07090a}
@media (max-width: 860px){.dshtree_label{display:none}}
`

    /** A tree with roots: canopy on top, three roots below. */
    function TreeIcon() {
      return h('svg', {
        className: 'dshtree_icon',
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M8 6.4V13' }),
        h('path', { d: 'M8 9.2 5.4 11.4M8 9.2l2.6 2.2M8 11.4v1.9' }),
        h('path', { d: 'M8 1.9c2 0 3.4 1.3 3.4 2.9S10 6.9 8 6.9 4.6 6.4 4.6 4.8 6 1.9 8 1.9Z' }),
      )
    }

    const inject = ['slots', 'locale', 'layout']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory-tree: dictionaries')

      const select = (id) => {
        try {
          ctx.layout.selectPanel(id)
        } catch (error) {
          console.warn('[dsh-memory-tree] cannot select panel:', error)
        }
      }

      /** Header chip: switches the centre panel to the tree. */
      const TreeButton = (props) => {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        return h(React.Fragment, null,
          h('style', null, CSS),
          h('button', {
            type: 'button',
            className: 'dshtree_btn',
            title: t('hint'),
            'aria-label': t('open'),
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              select(PANEL_ID)
            },
          },
            h(TreeIcon),
            h('span', { className: 'dshtree_label' }, t('open')),
          ),
        )
      }

      /** Centre panel: toolbar with a way back, a manual refresh, then the page. */
      const TreePage = (props) => {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const frame = React.useRef(null)
        const [busy, setBusy] = React.useState(false)
        const [note, setNote] = React.useState('')

        const refresh = async () => {
          if (busy) return
          setBusy(true)
          setNote(t('refreshing'))
          try {
            const response = await fetch(REFRESH_PATH, {
              method: 'POST',
              headers: { [REFRESH_HEADER]: '1' },
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok || !data.ok) {
              setNote(t('refreshFailed') + (data.error ? '：' + data.error : ''))
              return
            }
            setNote('')
            // 同源，直接重载当前页，保留 ?demo=1 之类的状态
            frame.current?.contentWindow?.location.reload()
          } catch (error) {
            setNote(t('refreshFailed') + '：' + (error?.message ?? error))
          } finally {
            setBusy(false)
          }
        }

        return h('div', { className: 'dshtree_page' },
          h('style', null, CSS),
          h('div', { className: 'dshtree_bar' },
            h('button', {
              type: 'button',
              className: 'dshtree_bar_button',
              onClick: () => select(HOME_PANEL),
            }, '← ' + t('back')),
            h('span', { className: 'dshtree_bar_title' }, note || t('title')),
            h('button', {
              type: 'button',
              className: 'dshtree_bar_button',
              disabled: busy,
              onClick: refresh,
            }, busy ? t('refreshing') : t('refresh')),
            h('button', {
              type: 'button',
              className: 'dshtree_bar_button',
              onClick: () => {
                try {
                  window.open(PAGE_PATH, '_blank', 'noopener')
                } catch (error) {
                  console.warn('[dsh-memory-tree] cannot open a window:', error)
                }
              },
            }, t('popout')),
          ),
          h('iframe', { ref: frame, className: 'dshtree_frame', src: PAGE_PATH, title: t('title') }),
        )
      }

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, TreePage))

      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'memory-tree',
        order: 5,
        locale: NS,
      }, TreeButton))
    }

    return { inject, apply }
  },
})
