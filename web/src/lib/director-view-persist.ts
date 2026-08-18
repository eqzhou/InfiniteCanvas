export function shouldPersistDirectorView(options: {
  previewing: boolean;
  cameraInteracted: boolean;
}): boolean {
  return options.cameraInteracted && !options.previewing;
}

/** Preview must drop an in-flight orbit so a late pointerup cannot persist the preview pose. */
export function navigationAfterDirectorPreviewStart(): {
  userNavigating: false;
  cameraInteracted: false;
} {
  return { userNavigating: false, cameraInteracted: false };
}
