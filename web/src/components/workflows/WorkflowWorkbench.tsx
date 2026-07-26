import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Plus, RefreshCw, Sparkles } from "lucide-react";

import { WorkflowRunCard } from "@/components/workflows/WorkflowRunCard";
import { WorkflowTemplateEditor } from "@/components/workflows/WorkflowTemplateEditor";
import { WorkflowVariableForm } from "@/components/workflows/WorkflowVariableForm";
import { getProvider } from "@/lib/ai-config";
import { createNode } from "@/lib/defaults";
import { nowIso, uid } from "@/lib/id";
import { parseWorkflowTemplate } from "@/lib/workflow-document";
import { createPersonalWorkflowTemplate } from "@/lib/workflow-template";
import { parseWorkflowRunParameters, parseWorkflowRunResult } from "@/lib/workflow-job";
import { generateText } from "@/services/ai-client";
import { deleteStorageKey, getBlob, resolveObjectUrl, uploadMedia } from "@/services/storage";
import {
  duplicateWorkflowTemplate,
  listWorkflowTemplates,
  removePersonalWorkflowTemplate,
  savePersonalWorkflowTemplate,
} from "@/services/workflow-templates";
import {
  cancelWorkflowRun,
  createWorkflowRun,
  listWorkflowRuns,
  resumeWorkflowRun,
  retryWorkflowRun,
} from "@/services/workflow-runs";
import { useBoardStore } from "@/stores/use-board-store";
import type { GenerationJob } from "@/types/board";
import type { WorkflowTemplate } from "@/types/workflow";

const WORKFLOW_AGENT_SYSTEM_PROMPT = [
  "你是图片创作工作流设计助手。",
  "只返回一个 JSON 对象，不要 Markdown。",
  "对象必须包含 title、description、category、variables、steps。",
  "variables 支持 text、textarea、select、number、boolean、image；steps 为 1-16 个图片步骤。",
  "提示词变量只能使用 {{变量ID}}，步骤图片依赖必须放在 references。",
].join("\n");

function initialValues(template: WorkflowTemplate): Record<string, unknown> {
  return Object.fromEntries(template.variables.map((variable) => {
    if (variable.kind === "image") return [variable.id, []];
    if ("default" in variable && variable.default !== undefined) return [variable.id, variable.default];
    if (variable.kind === "select") return [variable.id, variable.options[0] ?? ""];
    if (variable.kind === "number") return [variable.id, variable.min];
    return [variable.id, ""];
  }));
}

function extractJSONObject(value: string): unknown {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start || end - start > 256 * 1024) throw new Error("AI 没有返回有效工作流 JSON");
  return JSON.parse(value.slice(start, end + 1));
}

export function WorkflowWorkbench() {
  const config = useBoardStore((state) => state.config);
  const project = useBoardStore((state) => state.getActive());
  const commitWorkflowResultNodes = useBoardStore((state) => state.commitWorkflowResultNodes);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<WorkflowTemplate | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [imageFiles, setImageFiles] = useState<Record<string, File[]>>({});
  const [runs, setRuns] = useState<GenerationJob[]>([]);
  const [scope, setScope] = useState<"all" | "public" | "personal">("all");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const refreshTemplates = useCallback(async () => {
    const loaded = await listWorkflowTemplates();
    setTemplates(loaded);
    const selected = loaded.find((template) => template.id === selectedId) ?? loaded[0] ?? null;
    if (selected) {
      setSelectedId(selected.id);
      setDraft(structuredClone(selected));
      setValues(initialValues(selected));
      setImageFiles({});
    }
  }, [selectedId]);

  const refreshRuns = useCallback(async () => {
    setRuns(await listWorkflowRuns(project?.id));
  }, [project?.id]);

  useEffect(() => {
    void Promise.all([refreshTemplates(), refreshRuns()]).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const active = runs.find((job) => job.status === "queued" || job.status === "running");
    if (!active || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    void resumeWorkflowRun(active, config, {
      signal: controller.signal,
      onUpdate: (updated) => setRuns((current) => [updated, ...current.filter((job) => job.id !== updated.id)]),
    }).then(refreshRuns).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    });
    return () => controller.abort();
  }, [runs.some((job) => job.status === "queued" || job.status === "running"), config, refreshRuns]);

  const categories = useMemo(() => [...new Set(templates.map((template) => template.category).filter(Boolean))].sort(), [templates]);
  const filtered = useMemo(() => templates.filter((template) =>
    (scope === "all" || template.scope === scope) && (category === "all" || template.category === category) &&
    (!search.trim() || `${template.title}\n${template.description}`.toLowerCase().includes(search.trim().toLowerCase()))),
  [templates, scope, category, search]);

  const selectTemplate = (template: WorkflowTemplate) => {
    setSelectedId(template.id);
    setDraft(structuredClone(template));
    setValues(initialValues(template));
    setImageFiles({});
    setError("");
  };

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await savePersonalWorkflowTemplate(parseWorkflowTemplate({ ...draft, updatedAt: nowIso() }));
      await refreshTemplates();
      setSelectedId(saved.id);
      setDraft(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createDraft = () => {
    const next = createPersonalWorkflowTemplate("新图片工作流", nowIso(), uid("workflow"));
    setSelectedId("");
    setDraft(next);
    setValues(initialValues(next));
    setImageFiles({});
  };

  const duplicateDraft = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const copy = draft.id && templates.some((template) => template.id === draft.id)
        ? await duplicateWorkflowTemplate(draft.id)
        : await savePersonalWorkflowTemplate({ ...structuredClone(draft), id: uid("workflow"), revision: 1, scope: "personal", title: `${draft.title} 副本`, createdAt: nowIso(), updatedAt: nowIso() });
      await refreshTemplates();
      setSelectedId(copy.id);
      setDraft(copy);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteDraft = async () => {
    if (!draft || draft.scope !== "personal" || !window.confirm(`删除“${draft.title}”？历史运行不会删除。`)) return;
    setBusy(true);
    try {
      await removePersonalWorkflowTemplate(draft.id);
      setSelectedId("");
      await refreshTemplates();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createWithAI = async () => {
    const channel = config.channels.find((item) => item.id === config.activeChannelId) ?? config.channels[0];
    const provider = channel ? getProvider(channel, "text") : undefined;
    if (!channel || !provider?.baseUrl || !provider.model || !agentPrompt.trim()) {
      setError(!agentPrompt.trim() ? "请描述想创建的工作流" : "请先配置文本模型渠道");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const output = await generateText({
        channel,
        model: provider.model,
        systemPrompt: WORKFLOW_AGENT_SYSTEM_PROMPT,
        prompt: agentPrompt.trim(),
      });
      const candidate = extractJSONObject(output) as Record<string, unknown>;
      const timestamp = nowIso();
      const next = parseWorkflowTemplate({
        ...candidate,
        schemaVersion: 1,
        id: uid("workflow"),
        revision: 1,
        scope: "personal",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      setSelectedId("");
      setDraft(next);
      setValues(initialValues(next));
      setImageFiles({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI 工作流草稿无效");
    } finally {
      setBusy(false);
    }
  };

  const startRun = async () => {
    if (!draft) return;
    const uploaded: string[] = [];
    let jobCreated = false;
    setBusy(true);
    setError("");
    try {
      const runValues = { ...values };
      for (const variable of draft.variables.filter((variable) => variable.kind === "image")) {
        const keys: string[] = [];
        for (const file of imageFiles[variable.id] ?? []) {
          const media = await uploadMedia(file, "image", { requirePersistent: true });
          uploaded.push(media.storageKey);
          keys.push(media.storageKey);
        }
        runValues[variable.id] = keys;
      }
      const job = await createWorkflowRun({ projectId: project?.id, template: draft, values: runValues });
      jobCreated = true;
      setRuns((current) => [job, ...current]);
      const controller = new AbortController();
      abortRef.current = controller;
      await resumeWorkflowRun(job, config, {
        signal: controller.signal,
        onUpdate: (updated) => setRuns((current) => [updated, ...current.filter((item) => item.id !== updated.id)]),
      });
      await refreshRuns();
    } catch (cause) {
      if (!jobCreated) {
        await Promise.allSettled(uploaded.map(deleteStorageKey));
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const insertResults = async (job: GenerationJob, storageKeys: string[]) => {
    const active = useBoardStore.getState().getActive();
    if (!active) throw new Error("请先创建画布");
    if (active.nodes.some((node) => node.metadata.workflowRunId === job.id && storageKeys.includes(node.metadata.storageKey ?? ""))) {
      throw new Error("该运行结果已经插入当前画布");
    }
    const parameters = parseWorkflowRunParameters(job.parameters);
    const result = parseWorkflowRunResult(job.result, parameters.templateSnapshot);
    const nodes = [];
    for (const [index, storageKey] of storageKeys.entries()) {
      const blob = await getBlob("image", storageKey);
      const content = await resolveObjectUrl("image", storageKey);
      if (!blob || !content) throw new Error("工作流结果媒体已丢失");
      const step = parameters.templateSnapshot.steps.find((candidate) => result.steps[candidate.id]?.storageKeys?.includes(storageKey));
      nodes.push(createNode("image", {
        x: (420 - active.viewport.x) / active.viewport.k + (index % 4) * 360,
        y: (260 - active.viewport.y) / active.viewport.k + Math.floor(index / 4) * 360,
      }, {
        id: uid("workflow_image"),
        title: step?.title ?? "工作流结果",
        metadata: {
          content,
          storageKey,
          mimeType: blob.type,
          bytes: blob.size,
          prompt: step?.promptTemplate,
          model: step?.model,
          status: "success",
          workflowRunId: job.id,
          workflowStepId: step?.id,
          workflowTemplateId: parameters.templateId,
          generationJobId: result.steps[step?.id ?? ""]?.childJobId,
        },
      }));
    }
    await commitWorkflowResultNodes(active.id, job.id, nodes);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ob-canvas)]">
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-4 py-3">
        <div className="mr-auto"><p className="ob-page-kicker">Workflow</p><h1 className="text-base font-semibold">图片创作工作流</h1></div>
        <div className="ob-segment" role="tablist" aria-label="工作台类型">
          <Link role="tab" aria-selected={false} className="ob-segment-item no-underline" to="/workbench/image">图片</Link>
          <Link role="tab" aria-selected={false} className="ob-segment-item no-underline" to="/workbench/video">视频</Link>
          <Link role="tab" aria-selected className="ob-segment-item no-underline" to="/workbench/workflows">工作流</Link>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto xl:grid-cols-[260px_minmax(420px,1fr)_360px]">
        <aside className="border-b border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 xl:border-b-0 xl:border-r" aria-label="工作流模板">
          <div className="mb-3 flex items-center gap-2"><strong className="mr-auto text-sm">模板</strong>
            <button type="button" className="ob-icon-btn" title="新建个人模板" onClick={createDraft}><Plus size={15} /></button>
            <button type="button" className="ob-icon-btn" title="刷新模板" onClick={() => void refreshTemplates()}><RefreshCw size={15} /></button></div>
          <input className="ob-field mb-2" aria-label="搜索工作流模板" placeholder="搜索模板" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="mb-2 grid grid-cols-2 gap-2">
            <select className="ob-field" aria-label="模板范围" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
              <option value="all">全部</option><option value="public">公开</option><option value="personal">个人</option>
            </select>
            <select className="ob-field" aria-label="模板分类" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="all">全部分类</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            {filtered.map((template) => <button key={template.id} type="button" aria-pressed={draft?.id === template.id}
              className={`w-full rounded-lg border p-3 text-left ${draft?.id === template.id ? "border-[var(--ob-accent)] bg-[var(--ob-accent-soft)]" : "border-[var(--ob-line)]"}`}
              onClick={() => selectTemplate(template)}><strong className="block truncate text-sm">{template.title}</strong><span className="mt-1 block text-xs text-[var(--ob-muted)]">{template.scope === "public" ? "公开" : "个人"} · {template.steps.length} 步</span></button>)}
          </div>
        </aside>

        <main className="min-w-0 space-y-5 p-5">
          <section className="rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-4">
            <div className="mb-2 flex items-center gap-2"><Sparkles size={16} /><strong className="text-sm">AI 创建工作流</strong><span className="text-xs text-[var(--ob-muted)]">生成后先预览，保存才入个人模板</span></div>
            <textarea className="ob-field min-h-20" aria-label="AI 工作流描述" placeholder="例如：先生成产品主图，再生成三个不同场景的系列图" value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} />
            <button type="button" className="ob-btn-secondary mt-2 inline-flex items-center gap-1 px-3 py-2 text-xs" disabled={busy} onClick={() => void createWithAI()}><Sparkles size={13} />生成草稿</button>
          </section>
          {draft ? <WorkflowTemplateEditor draft={draft} busy={busy} onChange={setDraft} onSave={() => void saveDraft()} onDelete={() => void deleteDraft()} onDuplicate={() => void duplicateDraft()} /> : <p className="text-sm text-[var(--ob-muted)]">请选择或创建模板</p>}
        </main>

        <aside className="border-t border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 xl:border-l xl:border-t-0" aria-label="工作流运行">
          {draft ? <WorkflowVariableForm template={draft} values={values} imageFiles={imageFiles} disabled={busy}
            onValuesChange={setValues} onImageFilesChange={(id, files) => setImageFiles((current) => ({ ...current, [id]: files }))} /> : null}
          <button type="button" className="ob-btn-primary mt-4 w-full rounded-xl px-4 py-3 font-semibold" disabled={!draft || busy} onClick={() => void startRun()}>{busy ? "处理中…" : "运行工作流"}</button>
          {error ? <p role="alert" className="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--ob-danger)_10%,transparent)] p-2 text-xs text-[var(--ob-danger)]">{error}</p> : null}
          {notice ? <p role="status" className="mt-3 rounded-lg bg-[var(--ob-accent-soft)] p-2 text-xs text-[var(--ob-accent)]">{notice}</p> : null}
          <div className="my-4 border-t border-[var(--ob-line)]" />
          <div className="mb-3 flex items-center"><strong className="mr-auto text-sm">运行历史</strong><button type="button" className="ob-icon-btn" title="刷新运行历史" onClick={() => void refreshRuns()}><RefreshCw size={15} /></button></div>
          <div className="space-y-3">
            {runs.map((job) => <WorkflowRunCard key={job.id} job={job} busy={busy}
              onCancel={() => {
                abortRef.current?.abort();
                void cancelWorkflowRun(job).then(refreshRuns).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
              }}
              onRetry={() => void retryWorkflowRun(job).then((next) => setRuns((current) => [next, ...current])).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}
              onInsert={(keys) => {
                setBusy(true);
                setError("");
                setNotice("");
                void insertResults(job, keys)
                  .then(() => setNotice("工作流结果已发送到当前画布"))
                  .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                  .finally(() => setBusy(false));
              }} />)}
          </div>
        </aside>
      </div>
    </div>
  );
}
