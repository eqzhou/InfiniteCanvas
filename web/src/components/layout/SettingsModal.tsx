import { useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { createDefaultChannel } from "@/lib/defaults";
import { listModels } from "@/services/ai-client";
import { webdavGetBlob, webdavPutBlob } from "@/services/webdav";
import { exportProjectBundle, importProjectBundle } from "@/lib/project-bundle";
import { uid } from "@/lib/id";
import { getProvider, normalizeChannel } from "@/lib/ai-config";
import type { AiProviderKind } from "@/types/board";

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useBoardStore((s) => s.config);
  const setConfig = useBoardStore((s) => s.setConfig);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;
  const channel =
    config.channels.find((c) => c.id === config.activeChannelId) ?? config.channels[0];

  const updateChannel = (patch: Partial<typeof channel>) => {
    setConfig({
      ...config,
      channels: config.channels.map((c) =>
        c.id === channel.id ? { ...c, ...patch } : c,
      ),
    });
  };

  const updateProvider = (kind: AiProviderKind, patch: Partial<ReturnType<typeof getProvider>>) => {
    const normalized = normalizeChannel(channel);
    updateChannel({ providers: { ...normalized.providers!, [kind]: { ...normalized.providers![kind], ...patch } } });
  };

  const pullModels = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await listModels(channel);
      setModels(list);
      if (!list.length) setError("未拉取到模型（Agent Plan 等需手动填写）");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-5 shadow-[var(--ob-shadow)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">设置</h2>
          <button type="button" className="text-[var(--ob-muted)]" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <Field label="渠道名称">
            <input
              className="field"
              value={channel.name}
              onChange={(e) => updateChannel({ name: e.target.value })}
            />
          </Field>
          <div className="space-y-3">
            {(["text", "image", "video", "audio"] as AiProviderKind[]).map((kind) => {
              const provider = getProvider(channel, kind);
              const labels = { text: "文本", image: "生图", video: "视频", audio: "音频" };
              return <div key={kind} className="rounded border border-[var(--ob-line)] p-3">
                <h3 className="mb-2 font-medium">{labels[kind]}模型服务</h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input className="field" aria-label={`${labels[kind]} URL`} value={provider.baseUrl} onChange={(e) => updateProvider(kind, { baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
                  <input className="field" aria-label={`${labels[kind]} API Key`} type="password" value={provider.apiKey} onChange={(e) => updateProvider(kind, { apiKey: e.target.value })} />
                  <input className="field" aria-label={`${labels[kind]}模型`} value={provider.model} onChange={(e) => updateProvider(kind, { model: e.target.value })} />
                </div>
              </div>;
            })}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="图片尺寸">
              <input
                className="field"
                value={config.imageSize}
                onChange={(e) => setConfig({ ...config, imageSize: e.target.value })}
              />
            </Field>
            <Field label="图片质量">
              <input
                className="field"
                value={config.imageQuality}
                onChange={(e) => setConfig({ ...config, imageQuality: e.target.value })}
              />
            </Field>
            <Field label="默认数量">
              <input
                className="field"
                type="number"
                min={1}
                max={8}
                value={config.imageCount}
                onChange={(e) =>
                  setConfig({ ...config, imageCount: Number(e.target.value) || 1 })
                }
              />
            </Field>
          </div>

          <div className="rounded-lg border border-[var(--ob-line)] p-3">
            <div className="mb-2 font-medium">WebDAV 备份（可选）</div>
            <div className="space-y-2">
              <Field label="WebDAV URL">
                <input
                  className="field"
                  value={config.webdavUrl ?? ""}
                  onChange={(e) => setConfig({ ...config, webdavUrl: e.target.value })}
                  placeholder="https://example.com/dav/openboard"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="用户名">
                  <input
                    className="field"
                    value={config.webdavUser ?? ""}
                    onChange={(e) => setConfig({ ...config, webdavUser: e.target.value })}
                  />
                </Field>
                <Field label="密码">
                  <input
                    className="field"
                    type="password"
                    value={config.webdavPass ?? ""}
                    onChange={(e) => setConfig({ ...config, webdavPass: e.target.value })}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        const state = useBoardStore.getState();
                        const project = state.getActive();
                        if (!project) throw new Error("当前没有可备份的画布");
                        const bundle = await exportProjectBundle(project);
                        await webdavPutBlob(state.config, "openboard-current.openboard", bundle);
                        alert("已上传当前画布完整备份");
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  上传当前画布
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        const state = useBoardStore.getState();
                        const blob = await webdavGetBlob(
                          state.config,
                          "openboard-current.openboard",
                        );
                        state.importProject(await importProjectBundle(blob));
                        alert("已从 WebDAV 导入完整画布备份");
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  导入云端画布
                </button>
              </div>
              <p className="text-xs text-[var(--ob-muted)]">
                浏览器直连 WebDAV；需 HTTPS 和目标服务允许 CORS。完整包包含当前画布媒体。
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void pullModels()}
            >
              {busy ? "拉取中…" : "拉取模型列表"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const ch = createDefaultChannel();
                setConfig({
                  ...config,
                  channels: [...config.channels, ch],
                  activeChannelId: ch.id,
                });
              }}
            >
              添加渠道
            </button>
            <select
              className="field max-w-[200px]"
              value={config.activeChannelId ?? ""}
              onChange={(e) => setConfig({ ...config, activeChannelId: e.target.value })}
            >
              {config.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {error ? <p className="text-[var(--ob-danger)]">{error}</p> : null}
          {models.length ? (
            <div className="max-h-40 overflow-auto rounded border border-[var(--ob-line)] p-2 text-xs">
              {models.map((m) => (
                <button
                  key={m}
                  type="button"
                  className="mr-2 mb-1 rounded bg-[var(--ob-accent-soft)] px-2 py-0.5"
                  onClick={() => updateProvider("text", { model: m })}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-[var(--ob-muted)]">
            API Key 仅保存在本机浏览器。Seedance / 火山方舟 Agent Plan 请将 Base URL 设为
            `.../api/plan/v3` 并手动填写模型名。渠道 id 占位：{uid("note").slice(0, 8)}…
          </p>
        </div>
      </div>
      <style>{`
        .field { width: 100%; border: 1px solid var(--ob-line); border-radius: 8px; padding: 8px 10px; background: transparent; color: var(--ob-ink); }
        .btn { border: 1px solid var(--ob-line); border-radius: 8px; padding: 8px 12px; background: var(--ob-accent-soft); }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[var(--ob-muted)]">{label}</span>
      {children}
    </label>
  );
}
