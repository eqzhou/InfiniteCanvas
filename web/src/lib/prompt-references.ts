import type { BoardProject } from "@/types/board";

export type PromptMediaKind = "image" | "video" | "audio";

export type PromptReference = {
  nodeId: string;
  kind: PromptMediaKind;
  label: string;
  title: string;
  content?: string;
  storageKey?: string;
};

export type PromptReferenceSegment =
  | { type: "text"; value: string }
  | { type: "reference"; reference: PromptReference };

const KIND_LABEL: Record<PromptMediaKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

function isPromptMediaKind(value: string): value is PromptMediaKind {
  return value === "image" || value === "video" || value === "audio";
}

export function buildPromptReferences(
  project: BoardProject | null | undefined,
  targetNodeId: string,
): PromptReference[] {
  if (!project) return [];
  const incoming = project.edges
    .filter((edge) => edge.to === targetNodeId)
    .map((edge) => edge.from);
  const target = project.nodes.find((node) => node.id === targetNodeId);
  const configured = target?.metadata.inputOrder?.filter((id) => incoming.includes(id)) ?? [];
  const orderedIds = [...configured, ...incoming.filter((id) => !configured.includes(id))];
  const counts: Record<PromptMediaKind, number> = { image: 0, video: 0, audio: 0 };
  const references: PromptReference[] = [];

  for (const id of orderedIds) {
    const source = project.nodes.find((node) => node.id === id);
    if (!source || !isPromptMediaKind(source.type)) continue;
    if (!source.metadata.storageKey && !source.metadata.content) continue;
    counts[source.type] += 1;
    references.push({
      nodeId: source.id,
      kind: source.type,
      label: `${KIND_LABEL[source.type]}${counts[source.type]}`,
      title: source.title,
      ...(source.metadata.content ? { content: source.metadata.content } : {}),
      ...(source.metadata.storageKey ? { storageKey: source.metadata.storageKey } : {}),
    });
  }
  return references;
}

export function activePromptReferences(
  value: string,
  references: readonly PromptReference[],
): PromptReference[] {
  const activeIds = new Set(
    splitPromptReferenceValue(value, references)
      .filter((segment): segment is Extract<PromptReferenceSegment, { type: "reference" }> =>
        segment.type === "reference")
      .map((segment) => segment.reference.nodeId),
  );
  return references.filter((reference) => activeIds.has(reference.nodeId));
}

export function splitPromptReferenceValue(
  value: string,
  references: readonly PromptReference[],
): PromptReferenceSegment[] {
  if (!value) return [];
  const candidates = [...references].sort((a, b) => b.label.length - a.label.length);
  const segments: PromptReferenceSegment[] = [];
  let offset = 0;

  while (offset < value.length) {
    let matchIndex = -1;
    let match: PromptReference | undefined;
    for (const reference of candidates) {
      const index = value.indexOf(reference.label, offset);
      if (index < 0) continue;
      if (matchIndex < 0 || index < matchIndex) {
        matchIndex = index;
        match = reference;
      }
    }
    if (!match) {
      segments.push({ type: "text", value: value.slice(offset) });
      break;
    }
    if (matchIndex > offset) {
      segments.push({ type: "text", value: value.slice(offset, matchIndex) });
    }
    segments.push({ type: "reference", reference: match });
    offset = matchIndex + match.label.length;
  }
  return segments;
}
