import type { FilmCapabilities } from "@/services/film-client";
import type { FilmSource } from "@/types/film";

export const FILM_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

export type FilmImportFormat = Exclude<FilmSource["format"], "text">;

type FilmFileMetadata = Readonly<Pick<File, "name" | "size" | "type">>;

const IMPORT_FORMATS: Record<string, {
  format: FilmImportFormat;
  mimeTypes: readonly string[];
  capability: keyof Pick<FilmCapabilities, "plainTextImport" | "markdownImport" | "docxImport" | "pdfImport">;
  label: string;
}> = {
  txt: { format: "txt", mimeTypes: ["text/plain"], capability: "plainTextImport", label: "TXT" },
  md: { format: "markdown", mimeTypes: ["text/markdown", "text/plain"], capability: "markdownImport", label: "Markdown" },
  docx: {
    format: "docx",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    capability: "docxImport",
    label: "DOCX",
  },
  pdf: { format: "pdf", mimeTypes: ["application/pdf"], capability: "pdfImport", label: "PDF" },
};

export type FilmImportPreflight = Readonly<{
  format: FilmImportFormat;
  clientText: boolean;
}>;

export function preflightFilmImport(file: FilmFileMetadata, capabilities: FilmCapabilities): FilmImportPreflight {
  const extension = file.name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const descriptor = IMPORT_FORMATS[extension];
  if (!descriptor) throw new Error("请选择 TXT、MD、DOCX 或 PDF 文件");
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error("文件为空或大小无效");
  const maxBytes = Math.min(FILM_IMPORT_MAX_BYTES, capabilities.maxImportBytes || FILM_IMPORT_MAX_BYTES);
  if (file.size > maxBytes) {
    if (maxBytes === FILM_IMPORT_MAX_BYTES) throw new Error("剧本文件不能超过 50 MiB");
    throw new Error(`剧本文件不能超过 ${Math.floor(maxBytes / (1024 * 1024))} MiB`);
  }
  const mime = file.type.trim().toLowerCase();
  if (mime && !descriptor.mimeTypes.includes(mime)) {
    throw new Error(`${descriptor.label} 文件的 MIME 类型不匹配`);
  }
  if (!capabilities[descriptor.capability]) {
    throw new Error(`服务端未启用 ${descriptor.label} 导入`);
  }
  return { format: descriptor.format, clientText: descriptor.format === "txt" || descriptor.format === "markdown" };
}
