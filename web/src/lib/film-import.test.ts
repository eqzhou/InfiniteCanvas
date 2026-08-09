import { describe, expect, test } from "bun:test";

import { FILM_IMPORT_MAX_BYTES, preflightFilmImport } from "./film-import";
import type { FilmCapabilities } from "@/services/film-client";

const capabilities: FilmCapabilities = {
  available: true,
  reason: "",
  plainTextImport: true,
  markdownImport: true,
  docxImport: true,
  pdfImport: true,
  fileUploadImport: true,
  maxImportBytes: FILM_IMPORT_MAX_BYTES,
  stageGeneration: true,
  generationJobs: true,
  assetBundleExport: true,
  mp4Export: true,
  mp4Diagnostic: "",
  agentOperations: ["status", "list", "validate", "run_stage"],
};

describe("film manuscript import preflight", () => {
  test("accepts TXT, Markdown, DOCX, and PDF with matching extensions and MIME types", () => {
    expect(preflightFilmImport({ name: "draft.txt", size: 12, type: "text/plain" }, capabilities).format).toBe("txt");
    expect(preflightFilmImport({ name: "draft.md", size: 12, type: "text/markdown" }, capabilities).format).toBe("markdown");
    expect(preflightFilmImport({
      name: "draft.docx",
      size: 12,
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }, capabilities).format).toBe("docx");
    expect(preflightFilmImport({ name: "draft.pdf", size: 12, type: "application/pdf" }, capabilities).format).toBe("pdf");
  });

  test("enforces the 50 MiB client limit and rejects extension/MIME mismatches", () => {
    expect(() => preflightFilmImport({
      name: "too-large.pdf",
      size: FILM_IMPORT_MAX_BYTES + 1,
      type: "application/pdf",
    }, capabilities)).toThrow("50 MiB");
    expect(() => preflightFilmImport({ name: "script.pdf", size: 20, type: "text/plain" }, capabilities))
      .toThrow("MIME");
    expect(() => preflightFilmImport({ name: "script.exe", size: 20, type: "application/octet-stream" }, capabilities))
      .toThrow("TXT、MD、DOCX 或 PDF");
  });

  test("rejects formats disabled by server capabilities", () => {
    expect(() => preflightFilmImport(
      { name: "scan.pdf", size: 20, type: "application/pdf" },
      { ...capabilities, pdfImport: false },
    )).toThrow("服务端未启用 PDF");
  });
});
