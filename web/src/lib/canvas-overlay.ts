/** Modal dialogs own wheel; document pointer-move must still reach OrbitControls. */
export function isModalDialogOpen(root: ParentNode = document): boolean {
  return Boolean(root.querySelector('[role="dialog"][aria-modal="true"]'));
}
