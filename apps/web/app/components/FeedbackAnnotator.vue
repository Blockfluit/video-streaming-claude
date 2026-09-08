<!-- apps/web/app/components/FeedbackAnnotator.vue -->
<script setup lang="ts">
/**
 * Pen, rectangle, arrow and text on top of a captured screenshot.
 *
 * The stage is drawn at the screenshot's natural resolution and scaled down
 * with `scaleX`/`scaleY` to fit the dialog. Konva's `Stage.getPointerPosition()`
 * only undoes *CSS* layout scaling of the canvas element — it knows nothing
 * about the stage's own `scaleX`/`scaleY` node transform, so it answers in
 * display-space (the shrunk-down size), not the natural space shapes are
 * stored and drawn in. `getRelativePointerPosition()` is the one that inverts
 * the stage's own transform on top of that, which is why `pointerPosition()`
 * below calls it instead — every shape then ends up stored in the same units
 * the exported image uses. `export()` asks for `pixelRatio: 1 / displayScale`
 * (see below), which renders the export back up to the screenshot's original
 * size regardless of how small or zoomed the editor displayed it.
 *
 * Shape ids are a plain counter, not `crypto.randomUUID()` — that API does
 * not exist on an insecure context (this app is opened from a phone on the
 * LAN over plain HTTP), and a disposable local id has no reason to risk it.
 *
 * `zoom` is a multiplier on top of that fit scale, not a replacement for it —
 * `displayScale` (fit × zoom) is what actually goes everywhere `scale` used
 * to: the stage's own `scaleX`/`scaleY`, the display box's pixel size, the
 * text tool's screen-space input position, and `export()`'s `pixelRatio`.
 * That last one is why zooming never touches export quality: `pixelRatio:
 * 1 / displayScale` always divides back out to the screenshot's natural
 * resolution, whatever the current zoom happens to be.
 *
 * Ctrl/Cmd+Z is a `window`-level listener, not scoped to the canvas — Konva's
 * stage is not itself a focusable element, so there is nothing to bind a
 * keydown to that would reliably have focus. It is safe at that scope only
 * because it is skipped whenever the event's target is an `INPUT`/`TEXTAREA`
 * (the text tool's own input, or the dialog's message field below this
 * component) — otherwise Ctrl+Z while typing feedback text would erase a
 * shape instead of undoing a keystroke. Registered in `onMounted` and torn
 * down in `onUnmounted`, so it is live only while this component actually
 * is — which is only while the dialog holding it is open.
 *
 * Ctrl/Cmd+scroll to zoom is bound to the `wheel` event on the scrollable
 * wrapper, not the stage, and only intercepts the event (`preventDefault`)
 * when the modifier is held — an unmodified wheel still scrolls the wrapper
 * normally. Konva itself is never asked to zoom; `zoom` driving `displayScale`
 * is the only zoom mechanism, shared with the toolbar buttons.
 *
 * Zooming keeps a point fixed rather than always growing from the top-left —
 * `zoomTo()` records which *content* pixel currently sits under the anchor
 * (the cursor, for a wheel zoom; the wrapper's own centre, for a toolbar
 * button, which has no cursor-over-the-image position to anchor to), applies
 * the new zoom, then — after `nextTick`, once the resized content has
 * actually been painted, since setting `scrollLeft`/`scrollTop` against the
 * *old* size gets silently clamped to it — sets `scrollLeft`/`scrollTop` so
 * that same content pixel ends up back under the anchor. "Content pixels"
 * here means natural-resolution units divided out of the current
 * `displayScale`, the same space `pointerPosition()` already works in.
 *
 * The hand tool pans by writing `scrollLeft`/`scrollTop` directly from raw
 * pointer deltas — it is the one tool that does not go through
 * `pointerPosition()`/Konva coordinates at all, because panning is a fact
 * about the scroll wrapper (a plain element), not about where anything
 * would be drawn.
 *
 * This component renders only the image/canvas region — its toolbar lives
 * in `FeedbackDialog`'s own template instead, in the message column rather
 * than sitting next to the picture. `defineExpose` below is what makes
 * that possible without moving any of the state above out of this
 * component: the parent reads/drives `tool`/`zoom`/`shapes` through the
 * exposed handle rather than owning any of it itself, so this file stays
 * the one place that understands Konva, coordinates and scrolling.
 */
import type Konva from 'konva'
import type { VueKonvaRef } from 'vue-konva'

const props = defineProps<{
  screenshot: string
}>()

type Tool = 'pen' | 'rectangle' | 'arrow' | 'text' | 'hand'

interface LineShape { id: number, type: 'line', config: { points: number[], stroke: string, strokeWidth: number, lineCap: 'round', lineJoin: 'round' } }
interface RectShape { id: number, type: 'rect', config: { x: number, y: number, width: number, height: number, stroke: string, strokeWidth: number } }
interface ArrowShape { id: number, type: 'arrow', config: { points: number[], stroke: string, strokeWidth: number, fill: string, pointerLength: number, pointerWidth: number } }
interface TextShape { id: number, type: 'text', config: { x: number, y: number, text: string, fill: string, fontSize: number } }
type Shape = LineShape | RectShape | ArrowShape | TextShape

const STROKE_COLOR = '#ef4444'
const STROKE_WIDTH = 4
/** A guess for the very first paint, before `scrollWrapperEl` has been measured. */
const FALLBACK_DISPLAY_WIDTH = 800
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_STEP = 0.25

const tool = ref<Tool>('pen')
const shapes = ref<Shape[]>([])
const currentShape = ref<Shape | null>(null)
const drawing = ref(false)
const dragStart = ref({ x: 0, y: 0 })
const zoom = ref(1)
const panning = ref(false)
const panStart = ref({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 })

let nextId = 0
const newId = () => nextId++

const image = ref<HTMLImageElement | null>(null)
const naturalWidth = ref(0)
const naturalHeight = ref(0)

/*
 * How big the scrollable wrapper actually is, measured once on mount rather
 * than assumed — the dialog is a share of the viewport, so "how much room is
 * there" genuinely depends on the screen this loads on, not a constant that
 * would either waste a 4K monitor's width or force a scrollbar on a laptop
 * at what is supposed to be the un-zoomed "fits without scrolling" view.
 * A CSS transform (the modal's open animation) does not affect
 * `clientWidth`/`clientHeight`, so this is safe to read as soon as the
 * component mounts — no need to wait for the animation to finish.
 */
const scrollWrapperEl = useTemplateRef<HTMLDivElement>('scrollWrapper')
const containerWidth = ref(FALLBACK_DISPLAY_WIDTH)
const containerHeight = ref(FALLBACK_DISPLAY_WIDTH)

onMounted(() => {
  if (scrollWrapperEl.value) {
    containerWidth.value = scrollWrapperEl.value.clientWidth
    containerHeight.value = scrollWrapperEl.value.clientHeight
  }

  const img = new Image()
  img.onload = () => {
    naturalWidth.value = img.naturalWidth
    naturalHeight.value = img.naturalHeight
    image.value = img
  }
  img.src = props.screenshot
})

/*
 * Width-only. Capping height too meant a tall capture — the common shape once
 * I2 scopes the capture to one viewport, but especially before that, when it
 * was the whole scrolled document — got scaled down until it fit *both*
 * dimensions, which for anything much taller than it is wide produced a thin,
 * unusable sliver. Letting the height fall out of the width scale and giving
 * the container its own scrollbar (below) keeps the drawing surface at a
 * usable size instead of compressing it.
 */
const scale = computed(() => {
  if (naturalWidth.value === 0) return 1
  return Math.min(1, containerWidth.value / naturalWidth.value)
})
/** The fit scale, adjusted by how far the zoom controls have moved it. */
const displayScale = computed(() => scale.value * zoom.value)
const displayWidth = computed(() => naturalWidth.value * displayScale.value)
const displayHeight = computed(() => naturalHeight.value * displayScale.value)

/*
 * Whether the image, at the current zoom, is smaller than the wrapper in
 * each direction — used to centre it instead of leaving it pinned in the
 * top-left corner with dead space to the right/below, which is what plain
 * block layout does by default once zooming out shrinks it below the
 * wrapper's size. Only applied when *both* fit (see the wrapper's own
 * class binding): centring an axis that is still overflowing runs into a
 * real CSS quirk, not just a look — a centred flex item that overflows its
 * container leaves the browser unable to scroll to the start-side overflow
 * at all, which would make the top-left of a zoomed-in image permanently
 * unreachable rather than just briefly off-screen.
 */
const fitsWidth = computed(() => displayWidth.value <= containerWidth.value)
const fitsHeight = computed(() => displayHeight.value <= containerHeight.value)

const stageConfig = computed(() => ({
  width: displayWidth.value,
  height: displayHeight.value,
  scaleX: displayScale.value,
  scaleY: displayScale.value,
}))

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
}

/**
 * Changes zoom while keeping one point of the *content* fixed under a given
 * position in the scroll wrapper's own viewport — `anchorX`/`anchorY`
 * default to its centre, for callers (the toolbar buttons) with no cursor
 * position to anchor to.
 */
function zoomTo(newZoom: number, anchorX?: number, anchorY?: number) {
  const wrapper = scrollWrapperEl.value
  if (!wrapper || newZoom === zoom.value) {
    zoom.value = newZoom
    return
  }

  const ax = anchorX ?? wrapper.clientWidth / 2
  const ay = anchorY ?? wrapper.clientHeight / 2
  const oldScale = displayScale.value

  // The anchor's position in scale-independent content units — the same
  // space shape coordinates live in.
  const contentX = (wrapper.scrollLeft + ax) / oldScale
  const contentY = (wrapper.scrollTop + ay) / oldScale

  zoom.value = newZoom

  nextTick(() => {
    const newScale = displayScale.value
    wrapper.scrollLeft = contentX * newScale - ax
    wrapper.scrollTop = contentY * newScale - ay
  })
}

function zoomIn(anchorX?: number, anchorY?: number) {
  zoomTo(clampZoom(zoom.value + ZOOM_STEP), anchorX, anchorY)
}
function zoomOut(anchorX?: number, anchorY?: number) {
  zoomTo(clampZoom(zoom.value - ZOOM_STEP), anchorX, anchorY)
}

/** Ctrl+scroll (or a trackpad pinch, which browsers report as a ctrl-flagged wheel event) zooms toward the cursor; a plain wheel scrolls the wrapper as normal. */
function onWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const wrapper = scrollWrapperEl.value
  const rect = wrapper?.getBoundingClientRect()
  const anchorX = rect ? event.clientX - rect.left : undefined
  const anchorY = rect ? event.clientY - rect.top : undefined
  if (event.deltaY < 0) zoomIn(anchorX, anchorY)
  else zoomOut(anchorX, anchorY)
}

/** Skipped while typing — the text tool's own input, or the dialog's message field — so Ctrl+Z there undoes a keystroke, not a shape. */
function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    undo()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const imageConfig = computed(() => ({
  image: image.value,
  x: 0,
  y: 0,
  width: naturalWidth.value,
  height: naturalHeight.value,
}))

/** Position placing an inline `<input>` for the text tool. `null` when not active. */
const textInput = ref<{ x: number, y: number, displayX: number, displayY: number } | null>(null)
const textValue = ref('')

/*
 * `autofocus` is not reliably honoured on an element inserted into the DOM
 * after the initial page load — it is a load-time attribute, and this input
 * appears from a click long after that. Focusing explicitly once the element
 * has actually mounted is the fix; `nextTick` is needed because `textInput`
 * flips to non-null in the same tick as the click handler, before Vue has
 * patched the DOM and the `v-if` has rendered the element the ref points at.
 */
const textInputEl = useTemplateRef<HTMLInputElement>('textInputEl')
watch(textInput, (value) => {
  if (value) nextTick(() => textInputEl.value?.focus())
})

interface KonvaPointerEvent { target: { getStage: () => { getRelativePointerPosition: () => { x: number, y: number } | null } }, evt: PointerEvent }

function pointerPosition(event: KonvaPointerEvent): { x: number, y: number } | null {
  return event.target.getStage().getRelativePointerPosition()
}

function onPointerDown(event: KonvaPointerEvent) {
  if (tool.value === 'hand') {
    const wrapper = scrollWrapperEl.value
    if (!wrapper) return
    panning.value = true
    panStart.value = {
      x: event.evt.clientX,
      y: event.evt.clientY,
      scrollLeft: wrapper.scrollLeft,
      scrollTop: wrapper.scrollTop,
    }
    return
  }

  const pos = pointerPosition(event)
  if (!pos) return

  if (tool.value === 'text') {
    /*
     * `preventDefault` on the native pointerdown, not tidiness. Without it,
     * the browser's own default mousedown action — shifting focus toward the
     * click target, since a bare `<canvas>` is not itself focusable — lands
     * *after* Vue has patched the DOM and the `watch` above has already
     * focused the freshly-mounted `<input>`. That later, browser-driven focus
     * shift then blurs the input we just focused, which fires `commitText`
     * via `@blur` before a single character can be typed — found by
     * instrumenting a real browser session (`document.addEventListener`
     * `focusin`/`focusout`), where the input reliably received focus and
     * then lost it again within the same task, every time. Reproduced with
     * Playwright and confirmed fixed by this line: without it the text tool
     * is not merely fragile, it cannot be used to enter text at all.
     */
    event.evt.preventDefault?.()
    textInput.value = { x: pos.x, y: pos.y, displayX: pos.x * displayScale.value, displayY: pos.y * displayScale.value }
    textValue.value = ''
    return
  }

  drawing.value = true
  dragStart.value = pos

  if (tool.value === 'pen') {
    currentShape.value = {
      id: newId(),
      type: 'line',
      config: { points: [pos.x, pos.y], stroke: STROKE_COLOR, strokeWidth: STROKE_WIDTH, lineCap: 'round', lineJoin: 'round' },
    }
  } else if (tool.value === 'rectangle') {
    currentShape.value = {
      id: newId(),
      type: 'rect',
      config: { x: pos.x, y: pos.y, width: 0, height: 0, stroke: STROKE_COLOR, strokeWidth: STROKE_WIDTH },
    }
  } else {
    currentShape.value = {
      id: newId(),
      type: 'arrow',
      config: { points: [pos.x, pos.y, pos.x, pos.y], stroke: STROKE_COLOR, strokeWidth: STROKE_WIDTH, fill: STROKE_COLOR, pointerLength: 10, pointerWidth: 10 },
    }
  }
}

function onPointerMove(event: KonvaPointerEvent) {
  if (tool.value === 'hand') {
    if (!panning.value) return
    const wrapper = scrollWrapperEl.value
    if (!wrapper) return
    wrapper.scrollLeft = panStart.value.scrollLeft - (event.evt.clientX - panStart.value.x)
    wrapper.scrollTop = panStart.value.scrollTop - (event.evt.clientY - panStart.value.y)
    return
  }

  if (!drawing.value || !currentShape.value) return
  const pos = pointerPosition(event)
  if (!pos) return

  const shape = currentShape.value
  if (shape.type === 'line') {
    shape.config.points = [...shape.config.points, pos.x, pos.y]
  } else if (shape.type === 'rect') {
    shape.config.width = pos.x - dragStart.value.x
    shape.config.height = pos.y - dragStart.value.y
  } else if (shape.type === 'arrow') {
    shape.config.points = [dragStart.value.x, dragStart.value.y, pos.x, pos.y]
  }
}

function onPointerUp() {
  if (tool.value === 'hand') {
    panning.value = false
    return
  }

  if (drawing.value && currentShape.value) {
    shapes.value.push(currentShape.value)
  }
  drawing.value = false
  currentShape.value = null
}

function commitText() {
  if (textInput.value && textValue.value.trim()) {
    shapes.value.push({
      id: newId(),
      type: 'text',
      config: { x: textInput.value.x, y: textInput.value.y, text: textValue.value, fill: STROKE_COLOR, fontSize: 24 },
    })
  }
  textInput.value = null
  textValue.value = ''
}

function undo() {
  shapes.value.pop()
}

const stageRef = useTemplateRef<VueKonvaRef<Konva.Stage>>('stage')

function exportImage(): string {
  const stage = stageRef.value?.getNode()
  if (!stage) return props.screenshot
  return stage.toDataURL({ pixelRatio: displayScale.value > 0 ? 1 / displayScale.value : 1 })
}

defineExpose({
  export: exportImage,
  tool,
  setTool: (t: Tool) => { tool.value = t },
  zoom,
  canZoomIn: computed(() => zoom.value < MAX_ZOOM),
  canZoomOut: computed(() => zoom.value > MIN_ZOOM),
  zoomIn: () => zoomIn(),
  zoomOut: () => zoomOut(),
  canUndo: computed(() => shapes.value.length > 0),
  undo,
})
</script>

<template>
  <!--
    The scroll wrapper is the whole of this component's own template now —
    there is no toolbar row above it here (see the top-of-file comment on
    `defineExpose`). The parent still gives this component a bounded
    `flex-1` height so only this region scrolls, not the whole dialog;
    `min-h-0`/`min-w-0` (passed in as fallthrough classes from
    `FeedbackDialog`) is what lets it actually shrink to that bound rather
    than growing to fit its content.

    `overflow-auto` on both axes, not just `-y`, because zooming in can
    make either dimension bigger than what's available, and this is the
    *only* thing that scrolls — the dialog around it does not. `@wheel` is
    here rather than on the stage: an unmodified wheel still has to scroll
    this box normally, which is what happens by default when `onWheel`
    returns early for anything without Ctrl/Cmd held.
  -->
  <div
    ref="scrollWrapper"
    class="overflow-auto"
    :class="[
      tool === 'hand' ? (panning ? 'cursor-grabbing' : 'cursor-grab') : '',
      fitsWidth && fitsHeight ? 'flex items-center justify-center' : '',
    ]"
    @wheel="onWheel"
  >
    <div class="relative inline-block" :style="{ width: `${displayWidth}px`, height: `${displayHeight}px` }">
      <v-stage
        v-if="image"
        ref="stage"
        :config="stageConfig"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
      >
        <v-layer>
          <v-image :config="imageConfig" />
          <template v-for="shape in shapes" :key="shape.id">
            <v-line v-if="shape.type === 'line'" :config="shape.config" />
            <v-rect v-else-if="shape.type === 'rect'" :config="shape.config" />
            <v-arrow v-else-if="shape.type === 'arrow'" :config="shape.config" />
            <v-text v-else :config="shape.config" />
          </template>
          <template v-if="currentShape">
            <v-line v-if="currentShape.type === 'line'" :config="currentShape.config" />
            <v-rect v-else-if="currentShape.type === 'rect'" :config="currentShape.config" />
            <v-arrow v-else-if="currentShape.type === 'arrow'" :config="currentShape.config" />
          </template>
        </v-layer>
      </v-stage>

      <input
        v-if="textInput"
        ref="textInputEl"
        v-model="textValue"
        type="text"
        class="absolute rounded border border-(--ui-border) bg-(--ui-bg) px-1 text-sm"
        :style="{ left: `${textInput.displayX}px`, top: `${textInput.displayY - 12}px` }"
        @blur="commitText"
        @keydown.enter="commitText"
      >
    </div>
  </div>
</template>
