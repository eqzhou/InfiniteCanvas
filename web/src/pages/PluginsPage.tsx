import { useMemo, useState } from "react";
import { Box, Download, ExternalLink, Plus, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { useNavigate } from "react-router";
import {
  comparePluginVersions,
  fetchPluginRegistry,
  fetchPluginManifest,
  installPluginManifest,
  persistPluginConfigChange,
  setPluginEnabled,
  uninstallPluginManifest,
} from "@/lib/plugin-catalog";
import { saveConfig } from "@/services/storage";
import { BUILTIN_PLUGINS } from "@/plugins/builtins";
import { useBoardStore } from "@/stores/use-board-store";
import { useLazyProjects } from "@/hooks/use-lazy-workspace";
import type { PluginManifest, PluginPermission, PluginRegistryEntry } from "@/types/board";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useI18n } from "@/i18n/I18nProvider";
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
  const { t } = useI18n();
  return (
    <article className="ob-card group flex min-h-48 flex-col p-5 transition-all hover:shadow-[var(--ob-elev-2)]">
      <div className="flex min-w-0 items-start gap-3.5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
          <Box size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-semibold text-[var(--ob-ink)]">{manifest.name}</h2>
            {builtin ? (
              <span className="ob-chip shrink-0 text-[10px]">{t("plugins.builtin")}</span>
            ) : null}
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-[var(--ob-muted)]">
            {manifest.id} · v{manifest.version}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-[var(--ob-muted)]">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t("plugins.enabledState", { name: manifest.name })}
            disabled={disabled}
            className="ob-switch"
            data-checked={enabled ? "true" : "false"}
            onClick={() => onEnabledChange(!enabled)}
          />
          <span className="text-[11px]" aria-hidden="true">{enabled ? t("plugins.enabled") : t("plugins.disabled")}</span>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-[var(--ob-muted)]">{manifest.description}</p>
      <p className="mt-2 text-xs text-[var(--ob-muted)]">
        {t("plugins.permissions", { permissions: manifest.permissions.length ? manifest.permissions.join(", ") : t("common.none") })}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-4 border-t border-[var(--ob-line)]">
        <button
          type="button"
          className="ob-btn ob-btn-primary ob-btn-sm"
          disabled={!enabled}
          onClick={onAdd}
        >
          <Plus size={14} aria-hidden /> {t("plugins.addCanvas")}
        </button>
        {update && onUpdate ? (
          <button type="button" className="ob-btn ob-btn-sm" disabled={disabled} onClick={onUpdate}>
            <RefreshCw size={13} aria-hidden /> {t("plugins.upgrade", { version: update.version })}
          </button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            className="ob-btn ob-btn-danger ob-btn-sm ml-auto"
            title={t("plugins.uninstall")}
            aria-label={t("plugins.uninstall")}
            disabled={disabled}
            onClick={onRemove}
          >
            <Trash2 size={13} aria-hidden />
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function PluginsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  useLazyProjects();
  const active = useBoardStore((state) => state.getActive());
  const addNode = useBoardStore((state) => state.addNode);
  const config = useBoardStore((state) => state.config);

  const [registrySource, setRegistrySource] = useState(
    config.pluginRegistryUrl || "https://openboard-official.github.io/plugins-registry/index.json",
  );
  const [source, setSource] = useState("");
  const [registry, setRegistry] = useState<PluginRegistryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingManifest, setPendingManifest] = useState<PluginManifest | null>(null);
  const [consented, setConsented] = useState<PluginPermission[]>([]);
  const [pendingUninstall, setPendingUninstall] = useState<PluginManifest | null>(null);

  const disabledPluginIds = config.disabledPluginIds ?? [];
  const installed = config.plugins ?? [];
  const builtinIds = useMemo(() => new Set(BUILTIN_PLUGINS.map((plugin) => plugin.id)), []);

  useEscapeDismiss(Boolean(pendingManifest) && !busy, () => {
    setPendingManifest(null);
    setConsented([]);
  });

  const loadRegistry = async () => {
    if (!registrySource.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await fetchPluginRegistry(registrySource);
      const current = useBoardStore.getState().config;
      const nextConfig = {
        ...current,
        pluginRegistryUrl: registrySource.trim(),
      };
      await persistPluginConfigChange(current, nextConfig, saveConfig);
      useBoardStore.setState({ config: nextConfig });
      setRegistry(payload.plugins);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!source.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const manifest = await fetchPluginManifest(source);
      if (builtinIds.has(manifest.id)) {
        throw new Error(t("plugins.remoteBuiltinConflict"));
      }
      setPendingManifest(manifest);
      setConsented([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const prepareRegistryInstall = async (entry: PluginRegistryEntry) => {
    setSource(entry.manifestUrl);
    setBusy(true);
    setError(null);
    try {
      const manifest = await fetchPluginManifest(entry.manifestUrl);
      if (builtinIds.has(manifest.id)) {
        throw new Error(t("plugins.remoteBuiltinConflict"));
      }
      if (manifest.id !== entry.id || manifest.version !== entry.version) {
        throw new Error(t("plugins.registryMismatch"));
      }
      setPendingManifest(manifest);
      setConsented([]);
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
      const nextPlugins = installPluginManifest(current.plugins ?? [], pendingManifest);
      const nextConfig = {
        ...current,
        plugins: nextPlugins,
        disabledPluginIds: setPluginEnabled(
          current.disabledPluginIds ?? [],
          pendingManifest.id,
          true,
        ),
      };
      await persistPluginConfigChange(current, nextConfig, saveConfig);
      useBoardStore.setState({ config: nextConfig });
      setPendingManifest(null);
      setConsented([]);
      setSource("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const executeUninstall = async (manifest: PluginManifest) => {
    setBusy(true);
    setError(null);
    try {
      const current = useBoardStore.getState().config;
      const nextConfig = {
        ...current,
        plugins: uninstallPluginManifest(current.plugins ?? [], manifest.id),
        disabledPluginIds: setPluginEnabled(
          current.disabledPluginIds ?? [],
          manifest.id,
          true,
        ),
      };
      await persistPluginConfigChange(current, nextConfig, saveConfig);
      useBoardStore.setState({ config: nextConfig });
      setPendingUninstall(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const togglePluginEnabled = async (manifest: PluginManifest, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const current = useBoardStore.getState().config;
      const nextConfig = {
        ...current,
        disabledPluginIds: setPluginEnabled(
          current.disabledPluginIds ?? [],
          manifest.id,
          enabled,
        ),
      };
      await persistPluginConfigChange(current, nextConfig, saveConfig);
      useBoardStore.setState({ config: nextConfig });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const updates = useMemo(() => new Map(registry
    .filter((entry) => {
      const existing = installed.find((plugin) => plugin.id === entry.id);
      return existing && comparePluginVersions(existing.version, entry.version) < 0;
    })
    .map((entry) => [entry.id, entry])), [installed, registry]);

  const addToCanvas = (manifest: PluginManifest) => {
    if (!active) {
      setError(t("plugins.openCanvasFirst"));
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
      <div className="ob-page ob-view-fade-in pb-12">
        <header className="ob-page-header">
          <div className="min-w-0">
            <span className="ob-page-kicker"><Box size={13} aria-hidden />{t("nav.plugins")}</span>
            <h1 className="ob-page-title">{t("plugins.title")}</h1>
            <p className="ob-page-desc">{t("plugins.description")}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="ob-chip text-xs text-[var(--ob-muted)]">
              {installed.length + BUILTIN_PLUGINS.length} {t("plugins.installed")}
            </span>
          </div>
        </header>

        <section className="ob-card mb-6 p-4 sm:p-5">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <label className="min-w-0 flex-1">
              <span className="sr-only">{t("plugins.registryUrl")}</span>
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
              <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> {t("plugins.refreshRegistry")}
            </button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="min-w-0 flex-1">
              <span className="sr-only">{t("plugins.manifestUrl")}</span>
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
              className="ob-btn ob-btn-primary"
              disabled={busy || !source.trim()}
              onClick={() => void install()}
            >
              {busy ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
              {busy ? t("plugins.validating") : t("plugins.installManifest")}
            </button>
          </div>
          {error ? <p role="alert" className="ob-banner mt-3 rounded-xl" data-tone="danger">{error}</p> : null}
          <p className="mt-2.5 flex items-center gap-1.5 text-xs text-[var(--ob-muted)]">
            <ExternalLink size={12} /> {t("plugins.securityHint")}
          </p>
        </section>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {BUILTIN_PLUGINS.map((manifest) => (
            <PluginCard
              key={manifest.id}
              manifest={manifest}
              builtin
              enabled={!disabledPluginIds.includes(manifest.id)}
              disabled={busy}
              onEnabledChange={(enabled) => void togglePluginEnabled(manifest, enabled)}
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
              onEnabledChange={(enabled) => void togglePluginEnabled(manifest, enabled)}
              update={updates.get(manifest.id)}
              onUpdate={updates.has(manifest.id)
                ? () => void prepareRegistryInstall(updates.get(manifest.id)!)
                : undefined}
              onAdd={() => addToCanvas(manifest)}
              onRemove={() => setPendingUninstall(manifest)}
            />
          ))}
          {registry.filter((entry) => !installed.some((plugin) => plugin.id === entry.id) && !builtinIds.has(entry.id)).map((entry) => (
            <article key={entry.id} className="ob-card flex min-h-48 flex-col p-5 transition-all hover:shadow-[var(--ob-elev-2)]">
              <div className="flex items-start gap-3.5">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
                  <Box size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-semibold text-[var(--ob-ink)]">{entry.name}</h2>
                  <p className="font-mono text-[11px] text-[var(--ob-muted)]">{entry.id} · v{entry.version}</p>
                </div>
                <span className="ob-chip ml-auto text-[10px]">{t("plugins.registry")}</span>
              </div>
              <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-[var(--ob-muted)]">{entry.description}</p>
              <button
                type="button"
                disabled={busy}
                className="ob-btn ob-btn-primary ob-btn-sm mt-auto w-fit"
                onClick={() => void prepareRegistryInstall(entry)}
              >
                <Download size={13} aria-hidden /> {t("plugins.install")}
              </button>
            </article>
          ))}
        </div>
      </div>

      {pendingManifest ? (
        <div className="ob-overlay z-[120] p-4" onClick={() => { if (!busy) { setPendingManifest(null); setConsented([]); } }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-install-title"
            className="ob-surface ob-view-fade-in mx-auto mt-[8vh] max-w-lg p-5 shadow-[var(--ob-elev-2)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ob-admin-section-header !mb-3">
              <span className="ob-admin-section-icon" aria-hidden><ShieldAlert size={16} /></span>
              <div className="ob-admin-section-heading">
                <h2 id="plugin-install-title" className="ob-admin-section-title">
                  {t("plugins.installTitle", { name: pendingManifest.name })}
                </h2>
                <p className="ob-admin-section-desc">{pendingManifest.id} · v{pendingManifest.version}</p>
              </div>
              <button
                type="button"
                className="ob-icon-btn ob-icon-btn-sm ml-auto"
                aria-label={t("common.close")}
                disabled={busy}
                onClick={() => { setPendingManifest(null); setConsented([]); }}
              >
                <X size={16} aria-hidden />
              </button>
            </div>

            <p className="mt-2 text-xs text-[var(--ob-muted)] leading-relaxed">
              {t("plugins.installWarning")}
            </p>

            <div className="mt-4 rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-3 text-xs">
              <span className="ob-micro-label mb-2 block">{t("plugins.permissionLabel")}</span>
              <div className="space-y-2">
                {pendingManifest.permissions.length ? pendingManifest.permissions.map((permission) => (
                  <label key={permission} className="flex items-center gap-2 cursor-pointer text-[var(--ob-ink)]">
                    <input
                      type="checkbox"
                      checked={consented.includes(permission)}
                      onChange={(event) => setConsented((current) => event.target.checked
                        ? [...current, permission]
                        : current.filter((item) => item !== permission))}
                    />
                    <span>{permission}</span>
                  </label>
                )) : <span className="text-[var(--ob-muted)]">{t("common.none")}</span>}
              </div>
            </div>

            <div className="ob-record-actions mt-5 justify-end">
              <button
                type="button"
                className="ob-btn"
                disabled={busy}
                onClick={() => {
                  setPendingManifest(null);
                  setConsented([]);
                }}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={busy || consented.length !== pendingManifest.permissions.length}
                className="ob-btn ob-btn-primary"
                onClick={() => void confirmInstall()}
              >
                {t("plugins.consentInstall")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingUninstall ? (
        <ConfirmDialog
          title={t("plugins.confirmUninstall", { name: pendingUninstall.name })}
          confirmLabel={t("plugins.uninstall")}
          tone="danger"
          busy={busy}
          onCancel={() => setPendingUninstall(null)}
          onConfirm={() => void executeUninstall(pendingUninstall)}
        />
      ) : null}
    </>
  );
}
