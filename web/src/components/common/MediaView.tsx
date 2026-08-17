import { displayCardSrc } from "@/lib/media-preview";

export function MediaView({
  kind,
  src,
  previewSrc,
  alt,
  className,
  fit = "cover",
  controls = false,
  autoPlay = false,
  muted = true,
  onActivate,
}: {
  kind: "image" | "video";
  src?: string;
  previewSrc?: string;
  alt: string;
  className?: string;
  fit?: "cover" | "contain";
  controls?: boolean;
  autoPlay?: boolean;
  muted?: boolean;
  onActivate?: () => void;
}) {
  const fitClass = fit === "contain" ? "object-contain" : "object-cover";
  const cardSrc = displayCardSrc(previewSrc, src);
  if (!cardSrc && !src) return null;

  if (kind === "image") {
    return (
      <img
        src={cardSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        className={className ?? `h-full w-full ${fitClass}`}
        onClick={onActivate}
      />
    );
  }

  if (controls && src) {
    return (
      <video
        src={src}
        poster={previewSrc || undefined}
        aria-label={alt}
        controls
        autoPlay={autoPlay}
        playsInline
        preload={autoPlay ? "auto" : "metadata"}
        className={className ?? `h-full w-full bg-black ${fitClass}`}
      />
    );
  }

  if (previewSrc) {
    return (
      <img
        src={previewSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        className={className ?? `h-full w-full ${fitClass}`}
        onClick={onActivate}
      />
    );
  }

  if (!src) return null;
  return (
    <video
      src={src}
      aria-label={alt}
      muted={muted}
      preload="metadata"
      playsInline
      draggable={false}
      className={className ?? `pointer-events-none h-full w-full bg-black ${fitClass}`}
    />
  );
}
