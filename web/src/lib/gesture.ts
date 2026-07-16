import type { Point, Viewport } from "@/types/board";

export interface PointerContact {
  readonly pointerId: number;
  readonly point: Readonly<Point>;
}

export type ActiveGesture =
  | { readonly kind: "idle" }
  | { readonly kind: "pan"; readonly pointerId: number; readonly last: Readonly<Point> }
  | {
      readonly kind: "pinch";
      readonly pointerIds: readonly [number, number];
      readonly startDistance: number;
      readonly startViewport: Readonly<Viewport>;
      readonly anchorWorld: Readonly<Point>;
    };

export interface GestureState {
  readonly viewport: Readonly<Viewport>;
  readonly pointers: readonly PointerContact[];
  readonly gesture: ActiveGesture;
}

export type GestureEvent =
  | { readonly type: "pointerdown"; readonly pointerId: number; readonly point: Readonly<Point> }
  | { readonly type: "pointermove"; readonly pointerId: number; readonly point: Readonly<Point> }
  | { readonly type: "pointerup"; readonly pointerId: number }
  | { readonly type: "pointercancel"; readonly pointerId: number };

export interface GestureOptions {
  readonly minScale?: number;
  readonly maxScale?: number;
}

const DEFAULT_MIN_SCALE = 0.15;
const DEFAULT_MAX_SCALE = 3;
const MIN_PINCH_DISTANCE = 0.001;

const copyPoint = (point: Readonly<Point>): Point => ({ x: point.x, y: point.y });

const copyViewport = (viewport: Readonly<Viewport>): Viewport => ({
  x: viewport.x,
  y: viewport.y,
  k: viewport.k,
});

const isFinitePoint = (point: Readonly<Point>): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

const distance = (a: Readonly<Point>, b: Readonly<Point>): number =>
  Math.hypot(b.x - a.x, b.y - a.y);

const midpoint = (a: Readonly<Point>, b: Readonly<Point>): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const createPinch = (
  first: PointerContact,
  second: PointerContact,
  viewport: Readonly<Viewport>,
): ActiveGesture => {
  const center = midpoint(first.point, second.point);
  return {
    kind: "pinch",
    pointerIds: [first.pointerId, second.pointerId],
    startDistance: Math.max(distance(first.point, second.point), MIN_PINCH_DISTANCE),
    startViewport: copyViewport(viewport),
    anchorWorld: {
      x: (center.x - viewport.x) / viewport.k,
      y: (center.y - viewport.y) / viewport.k,
    },
  };
};

const gestureForPointers = (
  pointers: readonly PointerContact[],
  viewport: Readonly<Viewport>,
): ActiveGesture => {
  if (pointers.length === 0) return { kind: "idle" };
  if (pointers.length === 1) {
    return {
      kind: "pan",
      pointerId: pointers[0].pointerId,
      last: copyPoint(pointers[0].point),
    };
  }
  return createPinch(pointers[0], pointers[1], viewport);
};

const scaleLimits = (options: GestureOptions): readonly [number, number] => {
  const min = options.minScale ?? DEFAULT_MIN_SCALE;
  const max = options.maxScale ?? DEFAULT_MAX_SCALE;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    throw new RangeError("Gesture scale limits must be finite, positive, and ordered");
  }
  return [min, max];
};

export function createGestureState(viewport: Readonly<Viewport>): GestureState {
  if (
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(viewport.k) ||
    viewport.k <= 0
  ) {
    throw new RangeError("Gesture viewport must contain finite coordinates and a positive scale");
  }
  return {
    viewport: copyViewport(viewport),
    pointers: [],
    gesture: { kind: "idle" },
  };
}

export function reduceGesture(
  state: GestureState,
  event: GestureEvent,
  options: GestureOptions = {},
): GestureState {
  if (event.type === "pointerdown") {
    if (!isFinitePoint(event.point) || state.pointers.some((p) => p.pointerId === event.pointerId)) {
      return state;
    }
    const pointers = [
      ...state.pointers,
      { pointerId: event.pointerId, point: copyPoint(event.point) },
    ];
    return {
      viewport: state.viewport,
      pointers,
      gesture: pointers.length === 2 ? gestureForPointers(pointers, state.viewport) : state.gesture.kind === "idle"
        ? gestureForPointers(pointers, state.viewport)
        : state.gesture,
    };
  }

  const pointerIndex = state.pointers.findIndex((p) => p.pointerId === event.pointerId);
  if (pointerIndex < 0) return state;

  if (event.type === "pointerup" || event.type === "pointercancel") {
    const pointers = state.pointers.filter((p) => p.pointerId !== event.pointerId);
    const activePointerEnded =
      (state.gesture.kind === "pan" && state.gesture.pointerId === event.pointerId) ||
      (state.gesture.kind === "pinch" && state.gesture.pointerIds.includes(event.pointerId));
    return {
      viewport: state.viewport,
      pointers,
      gesture: activePointerEnded ? gestureForPointers(pointers, state.viewport) : state.gesture,
    };
  }

  if (!isFinitePoint(event.point)) return state;
  const pointers = state.pointers.map((pointer, index) =>
    index === pointerIndex ? { pointerId: pointer.pointerId, point: copyPoint(event.point) } : pointer,
  );

  if (state.gesture.kind === "pan" && state.gesture.pointerId === event.pointerId) {
    const viewport = {
      ...state.viewport,
      x: state.viewport.x + event.point.x - state.gesture.last.x,
      y: state.viewport.y + event.point.y - state.gesture.last.y,
    };
    return {
      viewport,
      pointers,
      gesture: { kind: "pan", pointerId: event.pointerId, last: copyPoint(event.point) },
    };
  }

  if (state.gesture.kind === "pinch" && state.gesture.pointerIds.includes(event.pointerId)) {
    const pinch = state.gesture;
    const first = pointers.find((p) => p.pointerId === pinch.pointerIds[0]);
    const second = pointers.find((p) => p.pointerId === pinch.pointerIds[1]);
    if (!first || !second) return state;

    const [minScale, maxScale] = scaleLimits(options);
    const center = midpoint(first.point, second.point);
    const rawScale =
      pinch.startViewport.k * (distance(first.point, second.point) / pinch.startDistance);
    const k = Math.min(maxScale, Math.max(minScale, rawScale));
    return {
      viewport: {
        x: center.x - pinch.anchorWorld.x * k,
        y: center.y - pinch.anchorWorld.y * k,
        k,
      },
      pointers,
      gesture: pinch,
    };
  }

  return { ...state, pointers };
}
