import type { NodeMetadata } from "@/types/board";
import type { ImageTransformOperation, ImageTransformResult } from "./types";

export function createTransformLineage(
  sourceNodeId: string,
  operation: ImageTransformOperation,
  result: ImageTransformResult,
  parameters: Readonly<Record<string, string | number | boolean>>,
): Pick<NodeMetadata,
  "derivedFromId" | "transformOperation" | "transformProvider" | "transformModel" |
  "transformRequestId" | "transformParameters"
> {
  return {
    derivedFromId: sourceNodeId,
    transformOperation: operation,
    transformProvider: result.provider,
    transformModel: result.model,
    transformRequestId: result.requestId,
    transformParameters: { ...parameters },
  };
}
