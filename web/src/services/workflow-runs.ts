import type { AppConfig, GenerationJob } from "@/types/board";
import type { WorkflowRunResult, WorkflowTemplate, WorkflowValues } from "@/types/workflow";
import { buildWorkflowGenerationJob, parseWorkflowRunParameters, parseWorkflowRunResult } from "@/lib/workflow-job";
import {
  advanceWorkflowStep,
  finalizeWorkflowRun,
  getReadyWorkflowStepIds,
  resolveWorkflowStepChildJobIds,
  workflowChildJobId,
  workflowStateChildJobIds,
} from "@/lib/workflow-run";
import { compileWorkflowPrompt } from "@/lib/workflow-dag";
import { getProvider } from "@/lib/ai-config";
import { nowIso, uid } from "@/lib/id";
import { generateImages } from "@/services/ai-client";
import { completeGenerationActivity } from "@/services/generation-activity";
import { authFetch } from "@/services/auth-session";
import {
  cancelServerGenerationJob,
  createGenerationJob,
  failGenerationJobIfUnchanged,
  getGenerationJob,
  listGenerationJobs,
  updateGenerationJob,
  usesServerGenerationJobs,
  waitForGenerationJob,
} from "@/services/generation-jobs";
import { blobToDataUrl, deleteStorageKey, getBlob, uploadMedia } from "@/services/storage";

type WorkflowRunUpdate = (job: GenerationJob) => void;

function browserWorkflowFailure(error: unknown, stage: "provider" | "media" | "child-history" | "parent-checkpoint"): string {
  if (error instanceof DOMException) return `浏览器媒体持久化失败（${error.name}）`;
  if (!(error instanceof Error)) return "图片生成失败";
  if (/base64|data url/i.test(error.message)) return "图片结果编码无效";
  if (/indexeddb|object store|transaction|database|blob/i.test(error.message)) return "浏览器媒体持久化失败";
  if (/media is too large|size limit|too large/i.test(error.message)) return "图片结果超过大小限制";
  if (/mime|image size/i.test(error.message)) return "图片结果格式无效";
  if (/^(?:Image provider|Provider response)/.test(error.message)) return error.message.slice(0, 500);
  if (stage === "media") return "图片结果持久化失败";
  if (stage === "child-history" || stage === "parent-checkpoint") return "工作流检查点保存失败";
  return error.name && error.name !== "Error" ? `图片生成失败（${error.name}）` : "图片生成失败";
}

async function serverJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(path, init);
  if (!response.ok) throw new Error(`Workflow run failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function createWorkflowRun(input: {
  projectId?: string;
  template: WorkflowTemplate;
  values: Record<string, unknown>;
}): Promise<GenerationJob> {
  const job = buildWorkflowGenerationJob({
    id: uid("workflow_run"),
    projectId: input.projectId,
    template: input.template,
    values: input.values,
    executor: usesServerGenerationJobs() ? "workflow" : "browser",
    timestamp: nowIso(),
  });
  if (usesServerGenerationJobs()) {
    return serverJSON<GenerationJob>("generation-jobs/workflow", {
      method: "POST",
      body: JSON.stringify({
        id: job.id,
        projectId: job.projectId,
        templateSnapshot: job.parameters.templateSnapshot,
        values: job.parameters.values,
      }),
    });
  }
  const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...newJob } = job;
  return createGenerationJob({ ...newJob, id });
}

export async function listWorkflowRuns(projectId?: string): Promise<GenerationJob[]> {
  return (await listGenerationJobs({ projectId, kind: "workflow", page: 1, pageSize: 100 })).items;
}

function cancelledResult(job: GenerationJob): WorkflowRunResult {
  const parameters = parseWorkflowRunParameters(job.parameters);
  const result = parseWorkflowRunResult(job.result, parameters.templateSnapshot);
  return {
    ...result,
    steps: Object.fromEntries(Object.entries(result.steps).map(([id, state]) => [
      id,
      state.status === "pending" || state.status === "queued" || state.status === "running"
        ? { ...state, status: "cancelled" as const, error: "已取消" }
        : state,
    ])),
  };
}

export async function cancelWorkflowRun(job: GenerationJob): Promise<GenerationJob> {
  if (usesServerGenerationJobs()) return cancelServerGenerationJob(job.id);
  const parameters = parseWorkflowRunParameters(job.parameters);
  const result = parseWorkflowRunResult(job.result, parameters.templateSnapshot);
  await Promise.allSettled(Object.values(result.steps).flatMap((state) =>
    workflowStateChildJobIds(state).map((childId) => updateGenerationJob(childId, {
      status: "cancelled",
      error: "已取消",
    }).catch(() => undefined)),
  ));
  return updateGenerationJob(job.id, { status: "cancelled", error: "已取消", result: cancelledResult(job) });
}

export async function retryWorkflowRun(job: GenerationJob): Promise<GenerationJob> {
  const parameters = parseWorkflowRunParameters(job.parameters);
  return createWorkflowRun({
    projectId: job.projectId,
    template: parameters.templateSnapshot,
    values: parameters.values,
  });
}

async function persistParentState(
  job: GenerationJob,
  status: GenerationJob["status"],
  result: WorkflowRunResult,
  error = "",
  onUpdate?: WorkflowRunUpdate,
): Promise<GenerationJob> {
  const updated = await updateGenerationJob(job.id, { status, result, error });
  onUpdate?.(updated);
  return updated;
}

async function referenceDataUrls(storageKeys: string[]): Promise<string[]> {
  const values: string[] = [];
  let totalBytes = 0;
  for (const key of storageKeys) {
    const blob = await getBlob(key.startsWith("media:") ? "media" : "image", key);
    if (!blob || !blob.type.startsWith("image/")) throw new Error("工作流参考图已丢失");
    totalBytes += blob.size;
    if (totalBytes > 24 * 1024 * 1024) throw new Error("工作流参考图总大小超过 24 MB");
    values.push(await blobToDataUrl(blob));
  }
  return values;
}

function stepReferenceKeys(
  step: WorkflowTemplate["steps"][number],
  values: WorkflowValues,
  result: WorkflowRunResult,
): string[] {
  const keys: string[] = [];
  for (const reference of step.references) {
    if (reference.source === "variable") {
      const value = values[reference.variableId];
      if (Array.isArray(value)) keys.push(...value);
      continue;
    }
    const outputs = result.steps[reference.stepId]?.storageKeys ?? [];
    if (reference.output === "all") keys.push(...outputs);
    else if (outputs[reference.output]) keys.push(outputs[reference.output]!);
  }
  const unique = [...new Set(keys)];
  if (unique.length > 16) throw new Error("工作流步骤参考图超过 16 张");
  return unique;
}

function workflowChildStorageKeys(child: GenerationJob): string[] {
  const items = Array.isArray(child.result.items) ? child.result.items : [];
  return items.flatMap((item) => item && typeof item === "object" &&
    typeof (item as { storageKey?: unknown }).storageKey === "string"
    ? [(item as { storageKey: string }).storageKey] : []);
}

function withoutWorkflowStepError(state: WorkflowRunResult["steps"][string]): Omit<WorkflowRunResult["steps"][string], "error"> {
  return Object.fromEntries(Object.entries(state).filter(([key]) => key !== "error")) as Omit<WorkflowRunResult["steps"][string], "error">;
}

async function runBrowserStep(
  parent: GenerationJob,
  result: WorkflowRunResult,
  stepId: string,
  config: AppConfig,
  signal: AbortSignal | undefined,
  onUpdate?: WorkflowRunUpdate,
): Promise<{ parent: GenerationJob; result: WorkflowRunResult }> {
  const parameters = parseWorkflowRunParameters(parent.parameters);
  const step = parameters.templateSnapshot.steps.find((candidate) => candidate.id === stepId)!;
  const existingState = result.steps[stepId];
  const recordedIds = workflowStateChildJobIds(existingState ?? {});
  let existing: { found: false } | { found: true; count: number } | undefined;
  let leftoverSlot0: { found: false } | { found: true; count: number } | undefined;
  if (recordedIds.length === 1 && step.parameters.count > 1) {
    const recorded = await getGenerationJob(recordedIds[0]!);
    existing = recorded
      ? { found: true, count: typeof recorded.parameters?.count === "number" ? recorded.parameters.count : 0 }
      : { found: false };
  } else if (recordedIds.length === 0 && step.parameters.count > 1) {
    const slot0 = await getGenerationJob(workflowChildJobId(parent.id, step.id, 0));
    leftoverSlot0 = slot0
      ? { found: true, count: typeof slot0.parameters?.count === "number" ? slot0.parameters.count : 0 }
      : { found: false };
  }
  const childIds = resolveWorkflowStepChildJobIds(
    parent.id,
    step.id,
    step.parameters.count,
    recordedIds,
    existing,
    leftoverSlot0,
  );
  const splitSlots = childIds.length > 1;
  let nextResult = advanceWorkflowStep(parameters.templateSnapshot, result, stepId, {
    status: "queued",
    childJobId: childIds[0],
    childJobIds: childIds,
  });
  let nextParent = await persistParentState(parent, "running", nextResult, "", onUpdate);
  nextResult = advanceWorkflowStep(parameters.templateSnapshot, nextResult, stepId, { status: "running" });
  nextParent = await persistParentState(nextParent, "running", nextResult, "", onUpdate);

  const stagedKeys: string[] = [];
  const createdChildren: GenerationJob[] = [];
  const succeededChildIds = new Set<string>();
  let childSucceededPersisted = false;
  let stage: "provider" | "media" | "child-history" | "parent-checkpoint" = "provider";
  try {
    const referenceStorageKeys = stepReferenceKeys(step, parameters.values, nextResult);
    const channelId = step.providerId || config.activeChannelId || config.channels[0]?.id;
    const channel = config.channels.find((candidate) => candidate.id === channelId) ?? config.channels[0];
    const provider = channel ? getProvider(channel, "image") : undefined;
    if (!channel || !provider?.baseUrl || !provider.apiKey) throw new Error("工作流图片渠道未配置");
    const model = step.model || provider.model;
    if (!model) throw new Error("工作流图片模型未配置");
    const prompt = compileWorkflowPrompt(step, parameters.values);
    const batchId = splitSlots ? `wb_${parent.id}_${step.id}` : "";

    for (const [index, childId] of childIds.entries()) {
      let child = await getGenerationJob(childId);
      if (!child) {
        child = await createGenerationJob({
          id: childId,
          projectId: parent.projectId,
          kind: "image",
          status: "running",
          prompt,
          providerId: channel.id,
          model,
          parameters: {
            ...step.parameters,
            count: splitSlots ? 1 : step.parameters.count,
            ...(splitSlots ? { requestedCount: childIds.length, batchId } : {}),
            batchIndex: splitSlots ? index + 1 : 0,
            referenceStorageKeys,
            workflowRunId: parent.id,
            workflowStepId: step.id,
            ownerClientId: "workflow-browser",
          },
          result: {},
        });
      }
      createdChildren.push(child);
    }

    const succeededKeys: string[] = [];
    for (const child of createdChildren) {
      if (child.status === "succeeded") {
        succeededChildIds.add(child.id);
        succeededKeys.push(...workflowChildStorageKeys(child));
        continue;
      }
      const urls = await generateImages({
        channel,
        model,
        prompt,
        size: step.parameters.size,
        quality: step.parameters.quality,
        n: splitSlots ? 1 : step.parameters.count,
        transparentBackground: step.parameters.transparentBackground,
        referenceDataUrls: await referenceDataUrls(referenceStorageKeys),
        systemPrompt: config.systemPrompt,
        signal,
        activityId: child.id,
        activitySurface: "image-workbench",
        deferActivitySuccess: true,
      });
      stage = "media";
      const items = [];
      for (const url of urls) {
        const uploaded = await uploadMedia(url, "image", { requirePersistent: true });
        stagedKeys.push(uploaded.storageKey);
        const { blob: _blob, ...persisted } = uploaded;
        items.push(persisted);
      }
      stage = "child-history";
      await updateGenerationJob(child.id, { status: "succeeded", result: { items }, error: "" });
      completeGenerationActivity(child.id, "succeeded");
      succeededChildIds.add(child.id);
      succeededKeys.push(...stagedKeys.splice(0, stagedKeys.length));
    }
    childSucceededPersisted = true;
    nextResult = advanceWorkflowStep(parameters.templateSnapshot, nextResult, stepId, {
      status: "succeeded",
      storageKeys: succeededKeys,
    });
    stage = "parent-checkpoint";
    return { parent: await persistParentState(nextParent, "running", nextResult, "", onUpdate), result: nextResult };
  } catch (error) {
    if (childSucceededPersisted) {
      return { parent: nextParent, result: nextResult };
    }
    const failure = signal?.aborted ? "已取消" : browserWorkflowFailure(error, stage);
    await Promise.allSettled(createdChildren.map(async (child) => {
      if (succeededChildIds.has(child.id)) return;
      completeGenerationActivity(child.id, signal?.aborted ? "cancelled" : "failed", failure);
      await updateGenerationJob(child.id, {
        status: signal?.aborted ? "cancelled" : "failed",
        error: failure,
      }).catch(() => undefined);
    }));
    if (stagedKeys.length) await Promise.allSettled(stagedKeys.map(deleteStorageKey));
    nextResult = advanceWorkflowStep(parameters.templateSnapshot, nextResult, stepId, {
      status: signal?.aborted ? "cancelled" : "failed",
      error: failure,
    });
    nextParent = await persistParentState(nextParent, signal?.aborted ? "cancelled" : "failed", nextResult,
      failure, onUpdate);
    return { parent: nextParent, result: nextResult };
  }
}

export async function executeBrowserWorkflowRun(
  initial: GenerationJob,
  config: AppConfig,
  options: { signal?: AbortSignal; onUpdate?: WorkflowRunUpdate } = {},
): Promise<GenerationJob> {
  let parent = initial;
  const parameters = parseWorkflowRunParameters(parent.parameters);
  if (parameters.executor !== "browser") throw new Error("workflow is not browser-owned");
  let result = parseWorkflowRunResult(parent.result, parameters.templateSnapshot);
  if (Object.values(result.steps).some((state) => state.status === "queued" || state.status === "running")) {
    let interrupted = false;
    const recoveredSteps = await Promise.all(Object.entries(result.steps).map(async ([id, state]) => {
      if (state.status !== "queued" && state.status !== "running") return [id, state] as const;
      const childIds = workflowStateChildJobIds(state);
      const children = await Promise.all(childIds.map((childId) => getGenerationJob(childId)));
      const recoveredChildren = await Promise.all(children.map(async (child) => {
        if (!child || (child.status !== "queued" && child.status !== "running")) return child;
        return await failGenerationJobIfUnchanged(child, "页面刷新后浏览器任务已中断，请按快照重试") ?? child;
      }));
      if (recoveredChildren.length > 0 && recoveredChildren.every((child) => child?.status === "succeeded")) {
        const storageKeys = recoveredChildren.flatMap((child) => child ? workflowChildStorageKeys(child) : []);
        if (storageKeys.length > 0) {
          return [id, { ...withoutWorkflowStepError(state), status: "succeeded" as const, storageKeys }] as const;
        }
      }
      if (recoveredChildren.some((child) => child?.status === "succeeded")) {
        return [id, {
          ...withoutWorkflowStepError(state),
          status: "pending" as const,
          childJobId: childIds[0],
          childJobIds: childIds,
        }] as const;
      }
      interrupted = true;
      return [id, {
        ...state,
        status: "failed" as const,
        error: "页面刷新后浏览器任务已中断，请按快照重试",
      }] as const;
    }));
    result = {
      ...result,
      steps: Object.fromEntries(recoveredSteps),
    };
    parent = await persistParentState(parent, interrupted ? "failed" : "running", result,
      interrupted ? "页面刷新后浏览器任务已中断，请按快照重试" : "", options.onUpdate);
  }
  try {
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      const terminal = finalizeWorkflowRun(parameters.templateSnapshot, result);
      result = terminal.result;
      if (terminal.status === "succeeded" || terminal.status === "failed" || terminal.status === "cancelled") {
        const failedStepError = Object.values(result.steps).find((state) => state.status === "failed")?.error;
        return persistParentState(parent, terminal.status, result,
          terminal.status === "failed" ? failedStepError || "工作流执行失败" : terminal.status === "cancelled" ? "已取消" : "",
          options.onUpdate);
      }
      const ready = getReadyWorkflowStepIds(parameters.templateSnapshot, result);
      if (ready.length === 0) throw new Error("工作流没有可执行步骤");
      for (const stepId of ready) {
        const advanced = await runBrowserStep(parent, result, stepId, config, options.signal, options.onUpdate);
        parent = advanced.parent;
        result = advanced.result;
        // runBrowserStep swallows step failures so the parent keeps its checkpoint.
        // Stop the batch the way the server worker does: the run is already headed
        // for a terminal failure, and the remaining siblings would each bill another
        // provider call while flipping the parent back to "running".
        if (result.steps[stepId]?.status !== "succeeded") break;
      }
    }
  } catch (error) {
    if (options.signal?.aborted) return cancelWorkflowRun(parent);
    const terminal = finalizeWorkflowRun(parameters.templateSnapshot, result);
    await persistParentState(parent, "failed", terminal.result, "工作流执行失败", options.onUpdate).catch(() => undefined);
    throw error;
  }
}

export async function resumeWorkflowRun(
  job: GenerationJob,
  config: AppConfig,
  options: { signal?: AbortSignal; onUpdate?: WorkflowRunUpdate } = {},
): Promise<GenerationJob> {
  if (job.parameters.executor === "workflow") {
    return waitForGenerationJob(job.id, { signal: options.signal, onUpdate: options.onUpdate });
  }
  return executeBrowserWorkflowRun(job, config, options);
}
