import { useMemo, useState } from "react";
import { Box, Download, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import {
  comparePluginVersions,
  fetchPluginRegistry,
  fetchPluginManifest,
  persistPluginUpgrade,
  setPluginEnabled,
  uninstallPluginManifest,
} from "@/lib/plugin-catalog";
import { saveConfig } from "@/services/storage";
import { BUILTIN_PLUGINS } from "@/plugins/builtins";
import { useBoardStore } from "@/stores/use-board-store";
import type { PluginManifest, PluginPermission, PluginRegistryEntry } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

function PluginCard({
  manifest,
  builtin,
  onAdd,
  onRemove,
  update,
  onUpdate,
  enabled,
  onEnabledChange,
  disabled = false,
}: {
  manifest: PluginManifest;
  builtin: boolean;
  onAdd: () => void;
  onRemove?: () => void;
  update?: PluginRegistryEntry;
  onUpdate?: () => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <article className="ob-card flex min-h-48 flex-col p-5">
      <div className="flex min-w-0 items-start gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
          <Box size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-[var(--ob-ink)]">{manifest.name}</h2>
          <p className="text-xs text-[var(--ob-muted)]">
            {builtin ? "内置" : "已安装"} · {manifest.id} · v{manifest.version}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-[var(--ob-muted)]">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`${manifest.name} 启用状态`}
            disabled={disabled}
            className="ob-switch"
            data-checked={enabled ? "true" : "false"}
            onClick={() => onEnabledChange(!enabled)}
          />
          <span aria-hidden="true">{enabled ? "已启用" : "已停用"}</span>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 text-sm text-[var(--ob-muted)]">{manifest.description}</p>
      <p className="mt-2 text-xs text-[var(--ob-muted)]">
        权限：{manifest.permissions.length ? manifest.permissions.join("、") : "无"}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-4">
        <button
          type="button"
          className="ob-btn-primary rounded-lg px-3 py-1.5 text-sm font-medium"
          disabled={!enabled}
          onClick={onAdd}
        >
          <Plus size={15} /> 添加到画布
        </button>
        {update && onUpdate ? (
          <button type="button" className="ob-btn" onClick={onUpdate}>
            <RefreshCw size={15} /> 升级到 v{update.version}
          </button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            className="ob-btn-danger ml-auto rounded-lg p-2"
            title="卸载插件"
            onClick={onRemove}
          >
            <Trash2 size={17} />
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function PluginsPage() {
  const navigate = useNavigate();
  const config = useBoardStore((state) => state.config);
  const setConfig = useBoardStore((state) => state.setConfig);
  const flushConfig = useBoardStore((state) => state.flushConfig);
  const active = useBoardStore((state) => state.getActive());
  const addNode = useBoardStore((state) => state.addNode);
  const installed = config.plugins ?? [];
  const disabledPluginIds = config.disabledPluginIds ?? [];
  const [source, setSource] = useState("");
  const [registrySource, setRegistrySource] = useState(config.pluginRegistryUrl ?? "");
  const [registry, setRegistry] = useState<PluginRegistryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingManifest, setPendingManifest] = useState<PluginManifest | null>(null);
  const [consented, setConsented] = useState<PluginPermission[]>([]);
  const builtinIds = useMemo(() => new Set(BUILTIN_PLUGINS.map((plugin) => plugin.id)), []);
  useEscapeDismiss(Boolean(pendingManifest) && !busy, () => {
    setPendingManifest(null);
    setConsented([]);
  });

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const manifest = await fetchPluginManifest(source.trim());
      if (builtinIds.has(manifest.id)) throw new Error("远程插件不能覆盖内置插件");
      setPendingManifest(manifest);
      const existing = installed.find((plugin) => plugin.id === manifest.id);
      setConsented(existing?.permissions.filter((permission) => manifest.permissions.includes(permission)) ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadRegistry = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await fetchPluginRegistry(registrySource.trim());
      setRegistry(result.plugins);
      const current = useBoardStore.getState().config;
      setConfig({ ...current, pluginRegistryUrl: registrySource.trim() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const prepareRegistryInstall = async (entry: PluginRegistryEntry) => {
    setBusy(true);
    setError(null);
    try {
      const manifest = await fetchPluginManifest(entry.manifestUrl);
      if (manifest.id !== entry.id || manifest.version !== entry.version) {
        throw new Error("注册表条目与插件清单不一致");
      }
      if (builtinIds.has(manifest.id)) throw new Error("远程插件不能覆盖内置插件");
      const existing = installed.find((plugin) => plugin.id === manifest.id);
      setConsented(existing?.permissions.filter((permission) => manifest.permissions.includes(permission)) ?? []);
      setPendingManifest(manifest);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmInstall = async () => {
    if (!pendingManifest) return;
    setBusy(true);
    setError(null);
    try {
      const current = useBoardStore.getState().config;
      const plugins = await persistPluginUpgrade(
        current.plugins ?? [],
        pendingManifest,
        async (next) => saveConfig({ ...current, plugins: next }),
      );
      setConfig({ ...current, plugins });
      setSource("");
      setPendingManifest(null);
      setConsented([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPendingManifest(null);
    } finally {
      setBusy(false);
    }
  };

  const updates = useMemo(() => new Map(registry
    .filter((entry) => {
      const current = installed.find((plugin) => plugin.id === entry.id);
      return current && comparePluginVersions(entry.version, current.version) > 0;
    })
    .map((entry) => [entry.id, entry])), [installed, registry]);

  const addToCanvas = (manifest: PluginManifest) => {
    if (!active) {
      setError("请先创建或打开一个画布项目");
      return;
    }
    const { viewport } = active;
    addNode("plugin", {
      x: (window.innerWidth / 2 - viewport.x) / viewport.k - manifest.defaultSize.width / 2,
      y: (window.innerHeight / 2 - viewport.y) / viewport.k - manifest.defaultSize.height / 2,
    }, {
      title: manifest.name,
      width: manifest.defaultSize.width,
      height: manifest.defaultSize.height,
      metadata: { pluginId: manifest.id, pluginState: {} },
    });
    navigate("/");
  };

  return (
    <>
      <div className="ob-page">
      <header className="ob-page-header">
        <div className="min-w-0">
          <p className="ob-page-kicker">Extensions</p>
          <h1 className="ob-page-title">插件</h1>
          <p className="ob-page-desc">插件运行在不同源浏览器沙箱中；远程插件仍属于可执行第三方代码。</p>
        </div>
      </header>

      <section className="ob-card mb-6 p-4 sm:p-5">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <label className="min-w-0 flex-1">
            <span className="sr-only">OpenBoard 插件注册表 URL</span>
            <input
              type="url"
              inputMode="url"
              className="ob-field"
              placeholder="https://registry.example/openboard.json"
              value={registrySource}
              onChange={(event) => setRegistrySource(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="ob-btn"
            disabled={busy || !registrySource.trim()}
            onClick={() => void loadRegistry()}
          >
            <RefreshCw size={16} className={busy ? "animate-spin" : ""} /> 刷新注册表
          </button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="min-w-0 flex-1">
            <span className="sr-only">HTTPS 插件清单 URL</span>
            <input
              type="url"
              inputMode="url"
              className="ob-field"
              placeholder="https://example.com/plugin.json"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="ob-btn"
            disabled={busy || !source.trim()}
            onClick={() => void install()}
          >
            {busy ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
            {busy ? "验证中" : "安装清单"}
          </button>
        </div>
        {error ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{error}</p> : null}
        <p className="mt-2 flex items-center gap-1 text-xs text-[var(--ob-muted)]">
          <ExternalLink size={13} /> 仅接受不跳转的 HTTPS JSON 清单，安装前会验证权限和大小。
        </p>
      </section>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {BUILTIN_PLUGINS.map((manifest) => (
          <PluginCard
            key={manifest.id}
            manifest={manifest}
            builtin
            enabled={!disabledPluginIds.includes(manifest.id)}
            disabled={busy}
            onEnabledChange={(enabled) => {
              setBusy(true);
              void (async () => {
                try {
                  const current = useBoardStore.getState().config;
                  setConfig({
                    ...current,
                    disabledPluginIds: setPluginEnabled(
                      current.disabledPluginIds ?? [],
                      manifest.id,
                      enabled,
                    ),
                  });
                  await flushConfig();
                } finally {
                  setBusy(false);
                }
              })().catch(() => undefined);
            }}
            onAdd={() => addToCanvas(manifest)}
          />
        ))}
        {installed.map((manifest) => (
          <PluginCard
            key={manifest.id}
            manifest={manifest}
            builtin={false}
            enabled={!disabledPluginIds.includes(manifest.id)}
            disabled={busy}
            onEnabledChange={(enabled) => {
              setBusy(true);
              void (async () => {
                try {
                  const current = useBoardStore.getState().config;
                  setConfig({
                    ...current,
                    disabledPluginIds: setPluginEnabled(
                      current.disabledPluginIds ?? [],
                      manifest.id,
                      enabled,
                    ),
                  });
                  await flushConfig();
                } finally {
                  setBusy(false);
                }
              })().catch(() => undefined);
            }}
            update={updates.get(manifest.id)}
            onUpdate={updates.has(manifest.id)
              ? () => void prepareRegistryInstall(updates.get(manifest.id)!)
              : undefined}
            onAdd={() => addToCanvas(manifest)}
            onRemove={() => {
              if (!window.confirm(`卸载 ${manifest.name}？现有节点会保留数据，但无法渲染。`)) return;
              const current = useBoardStore.getState().config;
              setConfig({
                ...current,
                plugins: uninstallPluginManifest(current.plugins ?? [], manifest.id),
                disabledPluginIds: setPluginEnabled(
                  current.disabledPluginIds ?? [],
                  manifest.id,
                  true,
                ),
              });
              void flushConfig();
            }}
          />
        ))}
        {registry.filter((entry) => !installed.some((plugin) => plugin.id === entry.id) && !builtinIds.has(entry.id)).map((entry) => (
          <article key={entry.id} className="ob-card flex min-h-48 flex-col p-5">
            <div className="flex items-start gap-4">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]"><Box size={20} /></span>
              <div className="min-w-0 flex-1"><h2 className="truncate font-semibold text-[var(--ob-ink)]">{entry.name}</h2><p className="text-xs text-[var(--ob-muted)]">{entry.id} · v{entry.version}</p></div>
              <span className="ob-chip ml-auto">注册表</span>
            </div>
            <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-[var(--ob-muted)]">{entry.description}</p>
            <button type="button" disabled={busy} className="ob-btn-primary mt-auto w-fit rounded-lg px-4 py-1.5 text-sm font-medium" onClick={() => void prepareRegistryInstall(entry)}>
              <Download size={15} /> 安装
            </button>
          </article>
        ))}
      </div>
      </div>
      {pendingManifest ? (
        <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-install-title"
            className="ob-surface-glass w-full max-w-lg p-6"
          >
            <h2 id="plugin-install-title" className="text-lg font-semibold text-[var(--ob-ink)]">
              安装 {pendingManifest.name}
            </h2>
            <p className="mt-2 text-sm text-[var(--ob-muted)]">
              远程插件包含可执行代码，可能通过页面导航或网络请求发送插件内的数据。仅安装你信任来源的插件。
            </p>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-[var(--ob-muted)]">标识</dt>
              <dd className="break-all">{pendingManifest.id} · v{pendingManifest.version}</dd>
              <dt className="text-[var(--ob-muted)]">权限</dt>
              <dd className="space-y-2">
                {pendingManifest.permissions.length ? pendingManifest.permissions.map((permission) => (
                  <label key={permission} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={consented.includes(permission)}
                      onChange={(event) => setConsented((current) => event.target.checked
                        ? [...current, permission]
                        : current.filter((item) => item !== permission))}
                    />
                    <span>{permission}</span>
                  </label>
                )) : "无"}
              </dd>
            </dl>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="ob-btn"
                onClick={() => {
                  setPendingManifest(null);
                  setConsented([]);
                }}
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy || consented.length !== pendingManifest.permissions.length}
                className="ob-btn-primary rounded-lg px-4 py-2 text-sm font-medium"
                onClick={() => void confirmInstall()}
              >
                同意并安装
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
