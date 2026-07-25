import { useEffect, useRef, useState } from "react";
import { GripVertical, Workflow } from "lucide-react";
import { Link } from "react-router-dom";
import {
  clampWorkflowEntryPosition,
  defaultWorkflowEntryPosition,
  parseWorkflowEntryPosition,
  type WorkflowEntryPosition,
} from "@/lib/draggable-workflow-entry";

const STORAGE_KEY = "openboard.workbench.workflow-entry-position";

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function initialPosition(): WorkflowEntryPosition {
  let persisted: WorkflowEntryPosition | null = null;
  try {
    persisted = parseWorkflowEntryPosition(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Restricted browser contexts may not expose localStorage.
  }
  return persisted
    ? clampWorkflowEntryPosition(persisted, viewport())
    : defaultWorkflowEntryPosition(viewport());
}

export function DraggableWorkflowEntry() {
  const [position, setPosition] = useState(initialPosition);
  const positionRef = useRef(position);
  const dragRef = useRef<Readonly<{ pointerId: number; offsetX: number; offsetY: number }> | null>(null);
  const movedRef = useRef(false);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const clamp = () => setPosition((current) => {
      const next = clampWorkflowEntryPosition(current, viewport());
      positionRef.current = next;
      return next;
    });
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const persist = (next: WorkflowEntryPosition) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Position persistence is optional in restricted browser contexts.
    }
  };

  return (
    <Link
      to="/workbench/workflows"
      aria-label="打开图片创作工作流"
      title="拖动入口，点击打开工作流"
      draggable={false}
      data-testid="draggable-workflow-entry"
      className="fixed z-40 flex h-12 w-44 touch-none select-none items-center gap-2 rounded-2xl border border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-3 text-sm font-semibold text-[var(--ob-ink)] shadow-[var(--ob-elev-3)] no-underline backdrop-blur-md"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        dragRef.current = {
          pointerId: event.pointerId,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
        };
        movedRef.current = false;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const next = clampWorkflowEntryPosition(
          { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY },
          viewport(),
        );
        if (Math.abs(next.x - position.x) > 2 || Math.abs(next.y - position.y) > 2) movedRef.current = true;
        positionRef.current = next;
        setPosition(next);
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        suppressClickRef.current = movedRef.current;
        persist(positionRef.current);
        event.currentTarget.releasePointerCapture(event.pointerId);
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        suppressClickRef.current = false;
      }}
      onClick={(event) => {
        if (suppressClickRef.current) event.preventDefault();
      }}
    >
      <GripVertical size={16} aria-hidden className="text-[var(--ob-muted)]" />
      <Workflow size={18} aria-hidden className="text-[var(--ob-accent)]" />
      <span>图片工作流</span>
    </Link>
  );
}
