<!-- apps/web/app/components/FeedbackAnnotator.vue -->
<script setup lang="ts">
/**
 * Pen, rectangle, arrow and text on top of a captured screenshot.
 *
 * The stage is drawn at the screenshot's natural resolution and scaled down
 * with `scaleX`/`scaleY` to fit the dialog — Konva reports pointer positions
 * already converted into that natural coordinate space, so every shape is
 * stored and drawn in the same units the exported image uses. `export()`
 * asks for `pixelRatio: 1 / scale`, which renders the export back up to the
 * screenshot's original size regardless of how small the editor displayed it.
 *
 * Shape ids are a plain counter, not `crypto.randomUUID()` — that API does
 * not exist on an insecure context (this app is opened from a phone on the
 * LAN over plain HTTP), and a disposable local id has no reason to risk it.
 */
import type Konva from 'konva'
import type { VueKonvaRef } from 'vue-konva'

const props = defineProps<{
  screenshot: string
}>()

type Tool = 'pen' | 'rectangle' | 'arrow' | 'text'

interface LineShape { id: number, type: 'line', config: { points: number[], stroke: string, strokeWidth: number, lineCap: 'round', lineJoin: 'round' } }
interface RectShape { id: number, type: 'rect', config: { x: number, y: number, width: number, height: number, stroke: string, strokeWidth: number } }
interface ArrowShape { id: number, type: 'arrow', config: { points: number[], stroke: string, strokeWidth: number, fill: string, pointerLength: number, pointerWidth: number } }
interface TextShape { id: number, type: 'text', config: { x: number, y: number, text: string, fill: string, fontSize: number } }
type Shape = LineShape | RectShape | ArrowShape | TextShape

const STROKE_COLOR = '#ef4444'
const STROKE_WIDTH = 4
const MAX_DISPLAY_WIDTH = 640
const MAX_DISPLAY_HEIGHT = 480

const tool = ref<Tool>('pen')
const shapes = ref<Shape[]>([])
const currentShape = ref<Shape | null>(null)
const drawing = ref(false)
const dragStart = ref({ x: 0, y: 0 })

let nextId = 0
const newId = () => nextId++

const image = ref<HTMLImageElement | null>(null)
const naturalWidth = ref(0)
const naturalHeight = ref(0)

onMounted(() => {
  const img = new Image()
  img.onload = () => {
    naturalWidth.value = img.naturalWidth
    naturalHeight.value = img.naturalHeight
    image.value = img
  }
  img.src = props.screenshot
})

const scale = computed(() => {
  if (naturalWidth.value === 0) return 1
  return Math.min(1, MAX_DISPLAY_WIDTH / naturalWidth.value, MAX_DISPLAY_HEIGHT / naturalHeight.value)
})
const displayWidth = computed(() => naturalWidth.value * scale.value)
const displayHeight = computed(() => naturalHeight.value * scale.value)

const stageConfig = computed(() => ({
  width: displayWidth.value,
  height: displayHeight.value,
  scaleX: scale.value,
  scaleY: scale.value,
}))

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

interface KonvaPointerEvent { target: { getStage: () => { getPointerPosition: () => { x: number, y: number } | null } } }

function pointerPosition(event: KonvaPointerEvent): { x: number, y: number } | null {
  return event.target.getStage().getPointerPosition()
}

function onPointerDown(event: KonvaPointerEvent) {
  const pos = pointerPosition(event)
  if (!pos) return

  if (tool.value === 'text') {
    textInput.value = { x: pos.x, y: pos.y, displayX: pos.x * scale.value, displayY: pos.y * scale.value }
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
  return stage.toDataURL({ pixelRatio: scale.value > 0 ? 1 / scale.value : 1 })
}

defineExpose({ export: exportImage })
</script>

<template>
  <div class="space-y-2">
    <div class="flex gap-1">
      <UButton size="xs" :variant="tool === 'pen' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-pencil" aria-label="Pen" @click="tool = 'pen'" />
      <UButton size="xs" :variant="tool === 'rectangle' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-square" aria-label="Rectangle" @click="tool = 'rectangle'" />
      <UButton size="xs" :variant="tool === 'arrow' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-move-up-right" aria-label="Arrow" @click="tool = 'arrow'" />
      <UButton size="xs" :variant="tool === 'text' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-type" aria-label="Text" @click="tool = 'text'" />
      <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-undo-2" :disabled="shapes.length === 0" aria-label="Undo" class="ml-auto" @click="undo" />
    </div>

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
        v-model="textValue"
        type="text"
        autofocus
        class="absolute rounded border border-(--ui-border) bg-(--ui-bg) px-1 text-sm"
        :style="{ left: `${textInput.displayX}px`, top: `${textInput.displayY - 12}px` }"
        @blur="commitText"
        @keydown.enter="commitText"
      >
    </div>
  </div>
</template>
