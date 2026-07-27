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
import { mergeSavedAdminChannels, shouldDeleteAdminChannel } from "@/lib/admin-channel-state";

const protocols: AdminChannelProtocol[] = ["openai", "gemini", "apimart", "kie"];

export function emptyAdminChannel(index: number): AdminChannel {
  return {
    id: `shared-${index}`,
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

function modelsText(channel: AdminChannel): string {
  return (channel.models ?? []).join("\n");
}

function parseModelsText(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function AdminChannelsPanel() {
  const [channels, setChannels] = useState<AdminChannel[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const persistedIdsRef = useRef(new Set<string>());

  const load = async () => {
    try {
      setError("");
      const loaded = await listAdminChannels();
      persistedIdsRef.current = new Set(loaded.map((channel) => channel.id));
      setChannels(loaded);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface)] p-4 text-sm text-[var(--ob-muted)]">
        启用且允许用户使用的渠道可由服务端执行图片、视频或音频任务；请求渠道 <code>shared-auto</code> 时按权重确定性选择并将具体渠道写入任务快照。填写「可用模型」后，自动路由只会选中列表内包含请求模型的渠道；留空表示不限制。共享密钥只可覆盖写入，不会返回浏览器。模型拉取目前支持 OpenAI/APIMart 兼容接口。
      </div>
      {channels.map((channel) => (
        <section key={channel.id} className="space-y-3 rounded-xl border border-[var(--ob-line)] p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="渠道 ID"><input className="ob-field" value={channel.id} disabled={persistedIdsRef.current.has(channel.id)} onChange={(event) => update(channel.id, { id: event.target.value })} /></Field>
            <Field label="名称"><input className="ob-field" value={channel.name} onChange={(event) => update(channel.id, { name: event.target.value })} /></Field>
            <Field label="协议"><select className="ob-field" value={channel.protocol} onChange={(event) => update(channel.id, { protocol: event.target.value as AdminChannelProtocol })}>{protocols.map((protocol) => <option key={protocol}>{protocol}</option>)}</select></Field>
            <Field label="基础 URL"><input className="ob-field" value={channel.baseUrl} onChange={(event) => update(channel.id, { baseUrl: event.target.value })} /></Field>
            <Field label="图片模型"><input className="ob-field" value={channel.defaultImageModel} onChange={(event) => update(channel.id, { defaultImageModel: event.target.value })} /></Field>
            <Field label="视频模型"><input className="ob-field" value={channel.defaultVideoModel} onChange={(event) => update(channel.id, { defaultVideoModel: event.target.value })} /></Field>
            <Field label="音频模型（仅 OpenAI）"><input className="ob-field" value={channel.defaultAudioModel} disabled={channel.protocol !== "openai"} onChange={(event) => update(channel.id, { defaultAudioModel: event.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="权重"><input className="ob-field" type="number" min={1} max={100} value={channel.weight} onChange={(event) => update(channel.id, { weight: Number(event.target.value) })} /></Field>
              <Field label="超时（秒）"><input className="ob-field" type="number" min={1} max={600} value={channel.timeoutSeconds} onChange={(event) => update(channel.id, { timeoutSeconds: Number(event.target.value) })} /></Field>
            </div>
            <Field label="可用模型（每行一个；留空不限制）">
              <textarea
                className="ob-field min-h-24 font-mono text-xs"
                value={modelsText(channel)}
                placeholder={"gpt-image-1\ngpt-image-2\nseedream-4"}
                onChange={(event) => update(channel.id, { models: parseModelsText(event.target.value) })}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={channel.enabled} onChange={(event) => update(channel.id, { enabled: event.target.checked })} />启用</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={channel.allowUserUse} onChange={(event) => update(channel.id, { allowUserUse: event.target.checked })} />允许普通用户</label>
            <label className="min-w-60 flex-1 text-sm">API 密钥（{channel.secretConfigured ? "已配置，可覆盖" : "未配置"}）<input className="ob-field mt-1" type="password" autoComplete="new-password" value={secrets[channel.id] ?? ""} onChange={(event) => setSecrets((current) => ({ ...current, [channel.id]: event.target.value }))} /></label>
            <button type="button" className="ob-btn" disabled={busy !== "" || !(secrets[channel.id] ?? "")} onClick={() => void run(`secret:${channel.id}`, async () => {
				await putAdminChannelSecret(channel.id, secrets[channel.id] ?? "", channel.secretBindingId ?? "");
              invalidateSharedChannelCatalog();
              setSecrets((current) => ({ ...current, [channel.id]: "" }));
              setChannels((current) => current.map((item) => item.id === channel.id ? { ...item, secretConfigured: true } : item));
              return "密钥已加密保存";
            })}>保存密钥</button>
            <button type="button" className="ob-btn" disabled={busy !== "" || !channel.secretConfigured} onClick={() => void run(`test:${channel.id}`, async () => {
              const result = await testAdminChannel(channel.id); return `连接成功，发现 ${result.modelCount} 个模型`;
            })}>测试连接</button>
            <button type="button" className="ob-btn" disabled={busy !== "" || !channel.secretConfigured || !["openai", "apimart"].includes(channel.protocol)} onClick={() => void run(`models:${channel.id}`, async () => {
              // Persist the fetched catalog on the channel so routing can use it.
              // Previously the result was only rendered as a transient notice.
              const models = await fetchAdminChannelModels(channel.id);
              update(channel.id, { models });
              return models.length
                ? `已写入 ${models.length} 个模型（保存全部后生效）：${models.slice(0, 20).join("、")}`
                : "连接成功，未返回模型";
            })}>拉取模型</button>
            <button type="button" className="ob-btn" disabled={busy !== ""} onClick={() => void run(`delete:${channel.id}`, async () => {
              const persisted = shouldDeleteAdminChannel(persistedIdsRef.current, channel.id);
              if (persisted) await deleteAdminChannel(channel.id);
              persistedIdsRef.current = new Set([...persistedIdsRef.current].filter((id) => id !== channel.id));
              invalidateSharedChannelCatalog();
              setChannels((current) => current.filter((item) => item.id !== channel.id));
              return persisted ? "渠道已删除" : "未保存渠道已移除";
            })}>删除</button>
          </div>
        </section>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ob-btn" onClick={() => setChannels((current) => [...current, emptyAdminChannel(current.length + 1)])}>添加渠道</button>
        <button type="button" className="ob-btn is-primary" disabled={busy !== ""} onClick={() => void run("save", async () => {
          const saved = await putAdminChannels(channels);
          persistedIdsRef.current = new Set(saved.map((channel) => channel.id));
          invalidateSharedChannelCatalog();
          setChannels(mergeSavedAdminChannels(saved, channels));
          return "共享渠道已保存";
        })}>保存全部</button>
      </div>
      {notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm">{label}<span className="mt-1 block">{children}</span></label>;
}
