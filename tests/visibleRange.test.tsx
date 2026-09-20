import * as React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useVisibleRange, visibleRange } from '../src/visibleRange'

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

const rectangle = (height: number): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height, toJSON: () => ({}) })

it('bounds a distant range without losing the first or final row', () => {
  const rows = Array.from({ length: 10000 }, (_, index) => ({ id: String(index), start: index * 40, height: 40 }))
  expect(visibleRange(rows, { top: 0, height: 200 }, 0)).toEqual([0, 6])
  expect(visibleRange(rows, { top: 200000, height: 200 }, 0)).toEqual([4999, 5006])
  expect(visibleRange(rows, { top: 399999, height: 200 }, 0)).toEqual([9999, 10000])
  expect(visibleRange(rows, { top: -600, height: 200 }, 0)).toEqual([0, 0])
})

it('mounts only the visible range, retains focused rows, and navigates to an unmounted target', async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  const flushFrames = async () => {
    for (let pass = 0; frames.size && pass < 10; pass++) await act(async () => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(performance.now()))
    })
    expect(frames.size).toBe(0)
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return rectangle(this.hasAttribute('data-visible-key') ? 40 : 200) })
  const scroll = vi.fn(function (this: HTMLElement) {
    const list = this.closest<HTMLElement>('[data-window-list]')!
    list.scrollTop = Number(this.dataset.visibleKey) * 40
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  const ids = Array.from({ length: 1000 }, (_, index) => String(index))
  let show!: (id: string, selector?: string) => void
  function List() {
    const visible = useVisibleRange(React, { ids, estimate: 40 })
    show = visible.show
    return <div data-window-list style={{ overflowY: 'auto', height: 200 }} ref={visible.ref}>{visible.render(index => <button data-visible-key={ids[index]}>{ids[index]}</button>)}</div>
  }
  const view = render(<List />)
  const list = view.container.firstElementChild as HTMLElement
  expect(list.style.overflowAnchor).toBe('none')
  expect(list.querySelectorAll('button').length).toBeLessThan(30)
  const first = list.querySelector('button')!
  await act(async () => { first.focus() })
  await act(async () => { list.scrollTop = 20000; fireEvent.scroll(list) })
  await flushFrames()
  await waitFor(() => expect(list.querySelector('[data-visible-key="500"]')).not.toBeNull())
  expect(list.querySelector('[data-visible-key="0"]')).toBe(first)
  expect(document.activeElement).toBe(first)
  await act(async () => { show('999', 'button') })
  await flushFrames()
  await waitFor(() => expect(document.activeElement).toHaveAttribute('data-visible-key', '999'))
  expect(list.querySelectorAll('button').length).toBeLessThan(30)
  expect(scroll).toHaveBeenCalled()
})

it('preserves a scroll anchor when a retained row above it changes height and releases observers', async () => {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element>; disconnected: boolean }> = []
  class Observer {
    private entry: typeof observers[number]
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, targets: new Set(), disconnected: false }; observers.push(this.entry) }
    observe(target: Element) { this.entry.targets.add(target) }
    unobserve(target: Element) { this.entry.targets.delete(target) }
    disconnect() { this.entry.disconnected = true; this.entry.targets.clear() }
  }
  vi.stubGlobal('ResizeObserver', Observer)
  let firstHeight = 40
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return rectangle(this.dataset.visibleKey === '0' ? firstHeight : this.hasAttribute('data-visible-key') ? 40 : 200) })
  const ids = Array.from({ length: 500 }, (_, index) => String(index))
  function List() {
    const visible = useVisibleRange(React, { ids, estimate: 40, pinned: ['0'] })
    return <div style={{ overflowY: 'auto', height: 200 }} ref={visible.ref}>{visible.render(index => <div data-visible-key={ids[index]}>{ids[index]}</div>)}</div>
  }
  const view = render(<List />)
  const list = view.container.firstElementChild as HTMLElement
  await act(async () => { list.scrollTop = 8000; fireEvent.scroll(list); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
  await waitFor(() => expect(list.querySelector('[data-visible-key="200"]')).not.toBeNull())
  const first = list.querySelector('[data-visible-key="0"]')!
  act(() => {
    firstHeight = 80
    for (const observer of observers.filter(observer => observer.targets.has(first))) observer.callback([{ target: first } as ResizeObserverEntry], {} as ResizeObserver)
  })
  expect(list.scrollTop).toBe(8040)
  view.unmount()
  expect(observers.every(observer => observer.disconnected)).toBe(true)
})
