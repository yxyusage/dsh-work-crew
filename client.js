/*
 * dsh-work-crew client half: a compact team strip in the composer dock that expands
 * into a board overlay. It only reads `/dsh-work-crew/state` served by the Host half.
 */
window.__ModuleLoader__.load({
  id: 'dsh-work-crew',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const C = {
      bg: 'var(--dsw-alias-bg-elevated, #1e1e22)',
      base: 'var(--dsw-alias-bg-base, #141416)',
      line: 'var(--dsw-alias-border-default, rgba(255,255,255,0.12))',
      text: 'var(--dsw-alias-text-primary, #ececf0)',
      muted: 'var(--dsw-alias-text-secondary, #9a9aa4)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      ok: '#2ea36b',
      warn: '#d79b28',
      bad: '#d3574a',
    };

    const STATUS_STYLE = {
      ready: { label: '待派', color: C.muted },
      running: { label: '进行中', color: C.brand },
      done: { label: '已完成', color: C.ok },
      blocked: { label: '阻塞', color: C.bad },
    };

    function Dot({ color, size = 7 }) {
      return h('span', {
        style: {
          width: size, height: size, borderRadius: '50%', background: color,
          display: 'inline-block', flex: '0 0 auto',
        },
      });
    }

    function useTeamState(active) {
      const [state, setState] = useState({ ok: false, boards: [], health: {} });
      const load = useCallback(async () => {
        try {
          const response = await fetch('/dsh-work-crew/state', { cache: 'no-store' });
          const data = await response.json();
          if (data && data.ok) setState(data);
        } catch { /* host not ready yet */ }
      }, []);
      useEffect(() => {
        if (!active) return undefined;
        load();
        const timer = setInterval(load, 4000);
        return () => clearInterval(timer);
      }, [active, load]);
      return [state, load];
    }

    function WorkerCard({ worker, health, tasks }) {
      const online = worker.online || health.online;
      const current = tasks.find((t) => t.worker === worker.id && t.status === 'running');
      return h('div', {
        style: {
          flex: '1 1 150px', minWidth: 140, padding: '8px 10px', borderRadius: 8,
          border: `1px solid ${C.line}`, background: C.base,
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
          h(Dot, { key: 'dot', color: online ? C.ok : C.bad }),
          h('span', { key: 'name', style: { fontWeight: 600, fontSize: 12.5 } }, worker.name),
          h('span', { key: 'st', style: { marginLeft: 'auto', fontSize: 11, color: C.muted } }, online ? '在线' : '离线'),
        ]),
        h('div', { key: 'role', style: { marginTop: 4, fontSize: 11, color: C.muted, lineHeight: 1.45, minHeight: 30 } },
          worker.role.length > 42 ? `${worker.role.slice(0, 42)}…` : worker.role),
        current
          ? h('div', { key: 'cur', style: { marginTop: 2, fontSize: 11, color: C.brand } }, `▸ ${current.id} ${current.title}`)
          : h('div', { key: 'idle', style: { marginTop: 2, fontSize: 11, color: C.muted } }, '空闲'),
      ]);
    }

    function Timeline({ events }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        events.slice(-10).reverse().map((event, index) => h('div', {
          key: `${event.t}-${index}`,
          style: { fontSize: 11, color: C.muted, display: 'flex', gap: 8 },
        }, [
          h('span', { key: 't', style: { color: C.text, opacity: 0.55, fontVariantNumeric: 'tabular-nums' } },
            new Date(event.t).toTimeString().slice(0, 8)),
          h('span', { key: 'm', style: { flex: 1 } }, event.message),
        ])));
    }

    function Board({ state, onClose }) {
      const board = state.boards[0];
      if (!board) {
        return h('div', { style: { padding: 20, color: C.muted, fontSize: 13 } },
          '还没有协作项目。让 DSH 调用 team_init 初始化一个项目，这里就会显示任务板。');
      }
      const health = state.health || {};
      const counts = board.tasks.reduce((acc, task) => {
        acc[task.status] = (acc[task.status] || 0) + 1;
        return acc;
      }, {});
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
        h('div', { key: 'sum', style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.5, color: C.muted } }, [
          h('span', { key: 'p', style: { color: C.text, fontWeight: 600, fontSize: 13 } }, board.project),
          h('span', { key: 'd', style: { opacity: 0.7 } }, board.dir),
          h('span', { key: 'c', style: { marginLeft: 'auto' } },
            `${counts.running || 0} 进行中 · ${counts.ready || 0} 待派 · ${counts.done || 0} 完成`),
        ]),
        h('div', { key: 'workers', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          board.workers.map((worker) => h(WorkerCard, {
            key: worker.id, worker, health: health[worker.id] || {}, tasks: board.tasks,
          }))),
        h('div', { key: 'tasks', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          board.tasks.length === 0
            ? [h('div', { key: 'none', style: { fontSize: 12, color: C.muted } }, '还没有任务。')]
            : board.tasks.map((task) => {
              const status = STATUS_STYLE[task.status] || STATUS_STYLE.ready;
              const worker = board.workers.find((w) => w.id === task.worker);
              return h('div', {
                key: task.id,
                style: {
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                  borderRadius: 6, background: task.status === 'running' ? 'rgba(77,107,254,0.12)' : 'transparent',
                  border: `1px solid ${task.status === 'running' ? 'rgba(77,107,254,0.35)' : 'transparent'}`,
                },
              }, [
                h('span', { key: 'id', style: { fontSize: 11, color: C.muted, width: 26 } }, task.id),
                h(Dot, { key: 'dot', color: status.color, size: 6 }),
                h('span', { key: 'title', style: { flex: 1, fontSize: 12.5, color: C.text } },
                  task.title,
                  task.dependsOn && task.dependsOn.length
                    ? h('span', { style: { color: C.muted, fontSize: 11 } }, `  ← ${task.dependsOn.join(',')}`)
                    : null),
                task.locks && task.locks.length
                  ? h('span', { key: 'locks', style: { fontSize: 10.5, color: C.warn } }, task.locks.join(' '))
                  : null,
                h('span', { key: 'w', style: { fontSize: 11, color: C.muted, width: 68, textAlign: 'right' } }, worker ? worker.name : task.worker),
                h('span', { key: 's', style: { fontSize: 11, color: status.color, width: 42, textAlign: 'right' } }, status.label),
              ]);
            })),
        h('div', { key: 'bottom', style: { display: 'flex', gap: 16, alignItems: 'flex-start' } }, [
          h('div', { key: 'locks', style: { flex: '0 0 auto' } }, [
            h('div', { key: 'h', style: { fontSize: 11, color: C.muted, marginBottom: 4 } }, '锁'),
            board.locks.length === 0
              ? h('div', { key: 'none', style: { fontSize: 11, color: C.muted } }, '无')
              : h('div', { key: 'list', style: { display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 220 } },
                board.locks.map((lock, index) => h('span', {
                  key: `${lock.resource}-${index}`,
                  style: {
                    fontSize: 10.5, padding: '2px 6px', borderRadius: 4, color: C.warn,
                    border: `1px solid ${C.line}`,
                  },
                }, `${lock.mode === 'write' ? 'W' : 'R'} ${lock.resource}`))),
          ]),
          h('div', { key: 'timeline', style: { flex: 1 } }, [
            h('div', { key: 'h', style: { fontSize: 11, color: C.muted, marginBottom: 4 } }, '时间线'),
            h(Timeline, { key: 't', events: board.events || [] }),
          ]),
        ]),
      ]);
    }

    function TeamStrip() {
      const [open, setOpen] = useState(false);
      const [state] = useTeamState(true);
      const board = state.boards[0];
      const tasks = board ? board.tasks : [];
      const running = tasks.filter((t) => t.status === 'running');
      const ready = tasks.filter((t) => t.status === 'ready');
      const online = board ? board.workers.filter((w) => w.online).length : 0;

      const strip = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
          fontSize: 11.5, color: C.muted, minHeight: 26,
        },
      }, [
        h(Dot, { key: 'd', color: running.length ? C.brand : (board ? C.ok : C.muted), size: 6 }),
        h('span', { key: 'label', style: { color: C.text, fontWeight: 500 } }, '协作团队'),
        board
          ? h('span', { key: 'stat' }, `${online}/${board.workers.length} 在线 · ${running.length} 进行中 · ${ready.length} 待派`)
          : h('span', { key: 'stat' }, '未初始化'),
        running[0]
          ? h('span', {
            key: 'cur',
            style: { color: C.brand, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 },
          }, `▸ ${running[0].title}`)
          : null,
        h('button', {
          key: 'btn',
          onClick: () => setOpen((value) => !value),
          style: {
            marginLeft: 'auto', border: `1px solid ${C.line}`, background: 'transparent',
            color: C.text, fontSize: 11, padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
          },
        }, open ? '收起' : '看板'),
      ]);

      if (!open) return strip;

      return h(React.Fragment, null, strip, h('div', {
        style: {
          position: 'fixed', right: 16, top: 72, bottom: 108, width: 430,
          maxWidth: 'calc(100vw - 32px)', overflow: 'auto', zIndex: 40,
          background: C.bg, color: C.text, border: `1px solid ${C.line}`, borderRadius: 10,
          boxShadow: '0 18px 48px rgba(0,0,0,0.45)', padding: 12,
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', marginBottom: 8 } }, [
          h('span', { key: 't', style: { fontWeight: 600, fontSize: 13 } }, '协作团队'),
          h('button', {
            key: 'x',
            onClick: () => setOpen(false),
            style: {
              marginLeft: 'auto', border: 'none', background: 'transparent',
              color: C.muted, fontSize: 16, cursor: 'pointer', lineHeight: 1,
            },
          }, '×'),
        ]),
        h(Board, { key: 'board', state, onClose: () => setOpen(false) }),
      ]));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-work-crew-strip',
          order: 40,
        }, TeamStrip));
      },
    };
  },
});
