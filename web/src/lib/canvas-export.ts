import { filenameForMimeType } from "@/lib/download-filename";

export function shouldIncludeCanvasExportNode(node: Node): boolean {
  // html-to-image applies this filter to text and other non-element nodes too.
  const element = node as Node & Partial<Pick<Element, "hasAttribute">>;
  if (typeof element.hasAttribute !== "function") return true;
  return !element.hasAttribute("data-canvas-control") &&
    !element.hasAttribute("data-canvas-export-ignore");
}

export function canvasExportFilename(title: string, now = new Date()): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  return filenameForMimeType(`${title || "openboard"}-${stamp}`, "image/png", "png");
}

export async function renderCanvasSnapshot(surface: HTMLElement): Promise<string> {
  const { toPng } = await import("html-to-image");
  const backgroundColor = getComputedStyle(document.documentElement)
    .getPropertyValue("--ob-bg")
    .trim() || "#ffffff";
  return toPng(surface, {
    cacheBust: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    backgroundColor,
    filter: shouldIncludeCanvasExportNode,
  });
}

export function downloadCanvasSnapshot(dataUrl: string, filename: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}
