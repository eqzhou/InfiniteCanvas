/**
 * Copy plain text in both secure and insecure contexts.
 *
 * `navigator.clipboard` is unavailable or rejects over plain HTTP (LAN IPs),
 * which is a common self-hosted access path. Fall back to a temporary textarea
 * and `document.execCommand("copy")` so the button still does something visible.
 */
export async function writeTextWithFallback(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Permission denied, non-secure context, or browser quirk — try the legacy path.
    }
  }
  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable");
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
  if (!copied) {
    throw new Error("复制失败");
  }
}
