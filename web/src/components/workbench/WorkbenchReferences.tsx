import { useEffect, useState } from "react";
import { ImagePlus } from "lucide-react";
import type { AssetItem } from "@/types/board";
import { getBlob } from "@/services/storage";

export function FileReferencePreviews({ files }: { files: readonly File[] }) {
  if (!files.length) return null;
  return (
    <div className="mt-2 flex gap-2 overflow-x-auto" aria-label="参考文件缩略图">
      {files.slice(0, 16).map((file, index) => <FileReferencePreview key={`${file.name}:${file.size}:${index}`} file={file} />)}
    </div>
  );
}

function FileReferencePreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url
    ? <img src={url} alt={file.name} title={file.name} className="h-14 w-14 shrink-0 rounded-lg border border-[var(--ob-line)] object-cover" />
    : <span title={file.name} className="grid h-14 w-14 shrink-0 place-items-center rounded-lg border border-[var(--ob-line)] px-1 text-center text-[9px] text-[var(--ob-muted)]">{file.type.split("/")[0]}</span>;
}

export function AssetReferenceThumbnail({ asset }: { asset: AssetItem }) {
  const [url, setUrl] = useState(asset.coverUrl || asset.content || "");
  useEffect(() => {
    if (!asset.storageKey) return;
    let objectURL = "";
    void getBlob(asset.storageKey.startsWith("media:") ? "media" : "image", asset.storageKey).then((blob) => {
      if (!blob) return;
      objectURL = URL.createObjectURL(blob);
      setUrl(objectURL);
    });
    return () => { if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [asset.storageKey]);
  return url
    ? <img src={url} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
    : <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--ob-canvas)]"><ImagePlus size={13} /></span>;
}
