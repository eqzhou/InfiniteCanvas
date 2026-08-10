import { useEffect, useRef, useState } from "react";
import {
  deleteAdminChannel,
  fetchAdminChannelModels,
  listAdminChannels,
  putAdminChannelSecret,
  putAdminChannels,
  testAdminChannel,
  type AdminChannel,
  type AdminChannelProtocol,
} from "@/services/admin";
import { invalidateSharedChannelCatalog } from "@/services/shared-channels";
import { uid } from "@/lib/id";
import {
  applyAdminChannelModelSelection,
  adminChannelSecretBindingIsCurrent,
  buildAdminChannelModelDiff,
  mergeSavedAdminChannels,
  shouldDeleteAdminChannel,
  type AdminChannelModelDiff,
} from "@/lib/admin-channel-state";

const protocols: AdminChannelProtocol[] = ["openai", "gemini", "apimart", "kie", "azure", "edge"];

export function adminChannelCanTest(
  channel: Pick<AdminChannel, "protocol" | "secretConfigured">,
): boolean {
  return channel.protocol === "edge" || channel.secretConfigured;
}

export function emptyAdminChannel(index: number): AdminChannel {
  return {
    id: uid("shared"),
    name: `共享渠道 ${index}`,
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai",
    enabled: true,
    allowUserUse: true,
    weight: 1,
    timeoutSeconds: 60,
    models: [],
    defaultTextModel: "",
    defaultImageModel: "",
    defaultVideoModel: "",
    defaultAudioModel: "",
    secretConfigured: false,
  };
}

export function AdminChannelNameField({
  channel,
  onChange,
}: {
  channel: Pick<AdminChannel, "name">;
  onChange: (name: string) => void;
}) {
  return (
    <Field label="渠道名称（用户可见）">
      <input className="ob-field" value={channel.name} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function modelsText(channel: AdminChannel): string {
  return (channel.models ?? []).join("\n");
}

function parseModelsText(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

interface PendingModelReview {
  diff: AdminChannelModelDiff;
  selected: string[];
}

export function AdminChannelsPanel() {
  const [channels, setChannels] = useState<AdminChannel[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [modelReviews, setModelReviews] = useState<Record<string, PendingModelReview>>({});
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState("");
  const persistedIdsRef = useRef(new Set<string>());
  const persistedChannelsRef = useRef(new Map<string, AdminChannel>());

  const load = async () => {
    setLoading(true);
    setLoaded(false);
    try {
      setError("");
      const result = await listAdminChannels();
      const loaded = result.items;
      setRevision(result.revision);
      persistedIdsRef.current = new Set(loaded.map((channel) => channel.id));
      persistedChannelsRef.current = new Map(loaded.map((channel) => [channel.id, channel]));
      setModelReviews({});
      setChannels(loaded);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const update = (id: string, patch: Partial<AdminChannel>) => {
    setChannels((current) => current.map((channel) => channel.id === id ? { ...channel, ...patch } : channel));
  };
  const run = async (key: string, operation: () => Promise<string>) => {
    try {
      setBusy(key); setError(""); setNotice(await operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-4" aria-busy={loading || busy !== ""}>
      <div className="rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface)] p-4 text-sm text-[var(--ob-muted)]">
        此处管理租户共享渠道，与工作区设置中的个人渠道相互独立。启用且允许用户使用的渠道可由服务端执行图片、视频或音频任务；请求渠道 <code>shared-auto</code> 时按权重确定性选择并将具体渠道写入任务快照。填写「可用模型」后，自动路由只会选中列表内包含请求模型的渠道；留空表示不限制。共享密钥只可覆盖写入，不会返回浏览器。模型拉取目前支持 OpenAI/APIMart 兼容接口。
      </div>
      {loading ? <p className="text-sm text-[var(--ob-muted)]">正在读取共享渠道…</p> : null}
      {!loading && !loaded ? <button type="button" className="ob-btn" onClick={() => void load()}>重新加载共享渠道</button> : null}
      <fieldset className="contents" disabled={busy !== "" || !loaded}>
      {channels.map((channel) => (
        <section key={channel.id} className="space-y-3 rounded-xl border border-[var(--ob-line)] p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <AdminChannelNameField channel={channel} onChange={(name) => update(channel.id, { name })} />
            <Field label="协议"><select className="ob-field" value={channel.protocol} onChange={(event) => update(channel.id, { protocol: event.target.value as AdminChannelProtocol })}>{protocols.map((protocol) => <option key={protocol}>{protocol}</option>)}</select></Field>
            <Field label="基础 URL"><input className="ob-field" value={channel.baseUrl} onChange={(event) => update(channel.id, { baseUrl: event.target.value })} /></Field>
            <Field label="图片模型"><input className="ob-field" value={channel.defaultImageModel} onChange={(event) => update(channel.id, { defaultImageModel: event.target.value })} /></Field>
            <Field label="视频模型"><input className="ob-field" value={channel.defaultVideoModel} onChange={(event) => update(channel.id, { defaultVideoModel: event.target.value })} /></Field>
            <Field label="音频模型"><input className="ob-field" value={channel.defaultAudioModel} disabled={!(["openai", "azure", "edge"] as AdminChannelProtocol[]).includes(channel.protocol)} onChange={(event) => update(channel.id, { defaultAudioModel: event.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="权重"><input className="ob-field" type="number" min={1} max={100} value={channel.weight} onChange={(event) => update(channel.id, { weight: Number(event.target.value) })} /></Field>
              <Field label="超时（秒）"><input className="ob-field" type="number" min={1} max={600} value={channel.timeoutSeconds} onChange={(event) => update(channel.id, { timeoutSeconds: Number(event.target.value) })} /></Field>
            </div>
            <Field label="可用模型（每行一个；留空不限制）">
              <textarea
                className="ob-field min-h-24 font-mono text-xs"
                value={modelsText(channel)}
                disabled={busy === `models:${channel.id}`}
                placeholder={"gpt-image-1\ngpt-image-2\nseedream-4"}
                onChange={(event) => {
                  update(channel.id, { models: parseModelsText(event.target.value) });
                  setModelReviews((current) => {
                    const { [channel.id]: _discarded, ...remaining } = current;
                    return remaining;
                  });
                }}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={channel.enabled} onChange={(event) => update(channel.id, { enabled: event.target.checked })} />启用</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={channel.allowUserUse} onChange={(event) => update(channel.id, { allowUserUse: event.target.checked })} />允许普通用户</label>
            <label className="min-w-60 flex-1 text-sm">API 密钥（{channel.protocol === "edge" ? "Edge 无需密钥" : channel.secretConfigured ? "已配置，可覆盖" : "未配置"}）<input className="ob-field mt-1" type="password" autoComplete="new-password" disabled={channel.protocol === "edge"} value={secrets[channel.id] ?? ""} onChange={(event) => setSecrets((current) => ({ ...current, [channel.id]: event.target.value }))} /></label>
            <button type="button" className="ob-btn" title={adminChannelSecretBindingIsCurrent(channel, persistedChannelsRef.current.get(channel.id)) ? undefined : "请先保存渠道配置"} disabled={busy !== "" || !(secrets[channel.id] ?? "") || !adminChannelSecretBindingIsCurrent(channel, persistedChannelsRef.current.get(channel.id))} onClick={() => void run(`secret:${channel.id}`, async () => {
              await putAdminChannelSecret(channel.id, secrets[channel.id] ?? "", channel.secretBindingId ?? "");
              invalidateSharedChannelCatalog();
              setSecrets((current) => ({ ...current, [channel.id]: "" }));
              setChannels((current) => current.map((item) => item.id === channel.id ? { ...item, secretConfigured: true } : item));
              return "密钥已加密保存";
            })}>{adminChannelSecretBindingIsCurrent(channel, persistedChannelsRef.current.get(channel.id)) ? "保存密钥" : "先保存渠道"}</button>
            <button type="button" className="ob-btn" disabled={busy !== "" || !adminChannelCanTest(channel)} onClick={() => void run(`test:${channel.id}`, async () => {
              const result = await testAdminChannel(channel.id); return `连接成功，发现 ${result.modelCount} 个模型`;
            })}>测试连接</button>
            <button type="button" className="ob-btn" disabled={busy !== "" || !channel.secretConfigured || !["openai", "apimart"].includes(channel.protocol)} onClick={() => void run(`models:${channel.id}`, async () => {
              const models = await fetchAdminChannelModels(channel.id);
              const diff = buildAdminChannelModelDiff(channel.models ?? [], models);
              setModelReviews((current) => ({
                ...current,
                [channel.id]: { diff, selected: [...diff.selected] },
              }));
              return models.length
                ? `已拉取 ${models.length} 个模型，请检查差异并确认更新`
                : "拉取结果为空，请检查差异并确认是否清空模型";
            })}>拉取模型</button>
            <button type="button" className="ob-btn" disabled={busy !== ""} onClick={() => void run(`delete:${channel.id}`, async () => {
              const persisted = shouldDeleteAdminChannel(persistedIdsRef.current, channel.id);
              if (persisted) setRevision(await deleteAdminChannel(channel.id, revision));
              persistedIdsRef.current = new Set([...persistedIdsRef.current].filter((id) => id !== channel.id));
              invalidateSharedChannelCatalog();
              setChannels((current) => current.filter((item) => item.id !== channel.id));
              setModelReviews((current) => {
                const { [channel.id]: _discarded, ...remaining } = current;
                return remaining;
              });
              return persisted ? "渠道已删除" : "未保存渠道已移除";
            })}>删除</button>
          </div>
          {modelReviews[channel.id] ? (
            <AdminChannelModelDiffReview
              diff={modelReviews[channel.id].diff}
              selected={modelReviews[channel.id].selected}
              onToggle={(model) => setModelReviews((current) => {
                const review = current[channel.id];
                if (!review) return current;
                const selected = review.selected.includes(model)
                  ? review.selected.filter((item) => item !== model)
                  : [...review.selected, model];
                return { ...current, [channel.id]: { ...review, selected } };
              })}
              onConfirm={() => {
                const review = modelReviews[channel.id];
                if (!review) return;
                const models = applyAdminChannelModelSelection(review.diff, review.selected);
                update(channel.id, { models });
                setModelReviews((current) => {
                  const { [channel.id]: _confirmed, ...remaining } = current;
                  return remaining;
                });
                setError("");
                setNotice(`已选择 ${models.length} 个模型（保存全部后生效）`);
              }}
              onCancel={() => setModelReviews((current) => {
                const { [channel.id]: _cancelled, ...remaining } = current;
                return remaining;
              })}
            />
          ) : null}
        </section>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ob-btn" disabled={!loaded || busy !== ""} onClick={() => setChannels((current) => [...current, emptyAdminChannel(current.length + 1)])}>添加渠道</button>
        <button type="button" className="ob-btn ob-btn-primary" disabled={!loaded || busy !== ""} onClick={() => void run("save", async () => {
          const result = await putAdminChannels(channels, revision);
          const saved = result.items;
          setRevision(result.revision);
          persistedIdsRef.current = new Set(saved.map((channel) => channel.id));
          persistedChannelsRef.current = new Map(saved.map((channel) => [channel.id, channel]));
          invalidateSharedChannelCatalog();
          setChannels(mergeSavedAdminChannels(saved));
          return "共享渠道已保存";
        })}>保存全部</button>
      </div>
      </fieldset>
      {notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    </div>
  );
}

export function AdminChannelModelDiffReview({
  diff,
  selected,
  onToggle,
  onConfirm,
  onCancel,
}: {
  diff: AdminChannelModelDiff;
  selected: readonly string[];
  onToggle: (model: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const selectedIds = new Set(selected);
  const groups = [
    { label: "新获取", models: diff.added, className: "text-emerald-700" },
    { label: "已有", models: diff.existing, className: "text-[var(--ob-muted)]" },
    { label: "已移除", models: diff.removed, className: "text-[var(--ob-danger)]" },
  ];

  return (
    <div className="space-y-3 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-surface)] p-3" aria-label="模型差异确认">
      <div>
        <p className="text-sm font-medium">模型拉取差异</p>
        <p className="text-xs text-[var(--ob-muted)]">
          {diff.selected.length === 0
            ? "拉取结果为空。已配置模型列在“已移除”中，确认前不会修改当前配置。"
            : "勾选确认后要保留的模型；确认前不会修改当前配置。"}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {groups.map((group) => (
          <div key={group.label} className="space-y-1">
            <p className={`text-xs font-medium ${group.className}`}>{group.label}（{group.models.length}）</p>
            {group.models.length ? group.models.map((model) => (
              <label key={model} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedIds.has(model)}
                  onChange={() => onToggle(model)}
                />
                <span className="break-all font-mono">{model}</span>
              </label>
            )) : <p className="text-xs text-[var(--ob-muted)]">无</p>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ob-btn ob-btn-primary" onClick={onConfirm}>确认更新模型</button>
        <button type="button" className="ob-btn" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm">{label}<span className="mt-1 block">{children}</span></label>;
}
