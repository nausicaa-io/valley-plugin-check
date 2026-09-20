import type { ReactNode, RefObject } from 'react'

type ReactApi = typeof import('react')
interface Row { id: string; height: number; start: number }
interface Viewport { top: number; height: number }

function scrollParent(element: HTMLElement): HTMLElement {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(current).overflowY) && (!current.clientHeight || current.scrollHeight > current.clientHeight + 1)) return current
  }
  return element.ownerDocument.scrollingElement as HTMLElement ?? element
}

export function visibleRange(rows: readonly Row[], viewport: Viewport, overscan = 320): [number, number] {
  const lower = viewport.top - overscan
  const upper = viewport.top + viewport.height + overscan
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle].start + rows[middle].height < lower) low = middle + 1
    else high = middle
  }
  const start = low
  high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle].start <= upper) low = middle + 1
    else high = middle
  }
  return [start, low]
}

export function useVisibleRange(React: ReactApi, options: {
  ids: readonly string[]
  estimate: number
  enabled?: boolean
  pinned?: readonly (string | null | undefined)[]
  layoutKey?: unknown
}): {
  ref: RefObject<HTMLDivElement>
  render(render: (index: number) => ReactNode): ReactNode[]
  show(id: string, focusSelector?: string): void
} {
  const { ids, estimate, pinned = [], layoutKey } = options
  const enabled = options.enabled ?? ids.length > 80
  const ref = React.useRef<HTMLDivElement>(null)
  const heights = React.useRef(new Map<string, number>())
  const [measurement, changed] = React.useReducer(value => value + 1, 0)
  const [viewport, setViewport] = React.useState<Viewport>({ top: 0, height: 600 })
  const [focused, setFocused] = React.useState<string | null>(null)
  const [requested, setRequested] = React.useState<{ id: string; selector?: string } | null>(null)
  const root = React.useRef<HTMLElement | null>(null)
  const frame = React.useRef<number | null>(null)
  const rows = React.useMemo(() => {
    let start = 0
    return ids.map(id => {
      const height = heights.current.get(id) ?? estimate
      const row = { id, height, start }
      start += height
      return row
    })
  }, [ids, estimate, measurement])
  const total = rows.length ? rows[rows.length - 1].start + rows[rows.length - 1].height : 0
  const model = React.useRef({ rows, viewport })
  model.current = { rows, viewport }
  const readViewport = React.useCallback(() => {
    const list = ref.current
    const parent = root.current
    if (!list || !parent) return
    const bounds = list.getBoundingClientRect()
    const box = parent.getBoundingClientRect()
    const height = parent.clientHeight || box.height || 600
    const top = parent === list ? parent.scrollTop : box.top - bounds.top
    setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height })
  }, [])
  const schedule = React.useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => { frame.current = null; readViewport() })
  }, [readViewport])
  React.useLayoutEffect(() => {
    const list = ref.current
    if (!list || !enabled) return
    const parent = scrollParent(list)
    root.current = parent
    const previousAnchor = list.style.overflowAnchor
    list.style.overflowAnchor = 'none'
    let listening = true
    const focus = () => {
      if (!listening) return
      const active = list.ownerDocument.activeElement
      const row = active instanceof Element ? active.closest<HTMLElement>('[data-visible-key]') : null
      setFocused(row && list.contains(row) ? row.dataset.visibleKey ?? null : null)
    }
    const blur = () => { queueMicrotask(focus) }
    parent.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    list.addEventListener('focusin', focus)
    list.addEventListener('focusout', blur)
    let width = list.clientWidth
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (list.clientWidth !== width) { width = list.clientWidth; heights.current.clear(); changed() }
      schedule()
    })
    resize?.observe(parent)
    if (parent !== list) resize?.observe(list)
    readViewport()
    return () => {
      listening = false
      if (list.style.overflowAnchor === 'none') list.style.overflowAnchor = previousAnchor
      parent.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      list.removeEventListener('focusin', focus)
      list.removeEventListener('focusout', blur)
      resize?.disconnect()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      root.current = null
    }
  }, [enabled, readViewport, schedule])
  React.useLayoutEffect(() => {
    const retained = new Set(ids)
    for (const key of heights.current.keys()) if (!retained.has(key)) heights.current.delete(key)
    readViewport()
  }, [ids, readViewport])
  React.useLayoutEffect(() => { heights.current.clear(); changed() }, [layoutKey])
  React.useLayoutEffect(() => {
    const list = ref.current
    if (!list || !enabled) return
    const measure = (elements: readonly Element[]) => {
      let difference = 0
      let dirty = false
      const { rows: current, viewport: view } = model.current
      const positions = new Map(current.map(row => [row.id, row]))
      for (const element of elements) {
        const id = (element as HTMLElement).dataset.visibleKey
        const row = id ? positions.get(id) : undefined
        const height = element.getBoundingClientRect().height
        if (!id || !row || height <= 0 || Math.abs(height - row.height) < 0.5) continue
        heights.current.set(id, height)
        if (row.start + row.height <= view.top) difference += height - row.height
        dirty = true
      }
      if (dirty) {
        if (difference && root.current) root.current.scrollTop += difference
        changed()
        schedule()
      }
    }
    const elements = Array.from(list.children).filter(element => element.hasAttribute('data-visible-key'))
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(entries => measure(entries.map(entry => entry.target)))
    elements.forEach(element => observer?.observe(element))
    measure(elements)
    return () => observer?.disconnect()
  })
  React.useLayoutEffect(() => {
    if (!requested) return
    const element = Array.from(ref.current?.children ?? []).find(element => (element as HTMLElement).dataset.visibleKey === requested.id) as HTMLElement | undefined
    if (!element) return
    element.scrollIntoView?.({ block: 'nearest' })
    if (requested.selector) (element.matches(requested.selector) ? element : element.querySelector<HTMLElement>(requested.selector))?.focus()
    readViewport()
    setRequested(null)
  }, [requested, rows, readViewport])
  const show = React.useCallback((id: string, selector?: string) => { setRequested({ id, selector }) }, [])
  const [from, to] = enabled ? visibleRange(rows, viewport) : [0, rows.length]
  const visible = new Set<number>()
  for (let index = from; index < to; index++) visible.add(index)
  const pins = new Set([...pinned, focused, requested?.id].filter(Boolean))
  if (pins.size) rows.forEach((row, index) => { if (pins.has(row.id)) visible.add(index) })
  return {
    ref,
    show,
    render(render) {
      const output: ReactNode[] = []
      let end = 0
      for (const index of [...visible].sort((a, b) => a - b)) {
        const row = rows[index]
        if (row.start > end) output.push(React.createElement('div', { key: `space:${row.id}`, 'aria-hidden': true, style: { height: row.start - end, flex: '0 0 auto', pointerEvents: 'none' } }))
        output.push(React.createElement(React.Fragment, { key: row.id }, render(index)))
        end = row.start + row.height
      }
      if (total > end) output.push(React.createElement('div', { key: 'space:end', 'aria-hidden': true, style: { height: total - end, flex: '0 0 auto', pointerEvents: 'none' } }))
      return output
    }
  }
}
