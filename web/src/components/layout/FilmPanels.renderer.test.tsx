import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useState, type ReactElement } from "react";
import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";

import { I18nProvider } from "@/i18n/I18nProvider";
import { createDefaultChannel, createDefaultConfig, createProject } from "@/lib/defaults";
import { createFilmDocument } from "@/lib/film-document";
import { DEFAULT_GENERATION_DEFAULTS } from "@/lib/generation-defaults";
import type { GenerationDefaults } from "@/lib/generation-defaults";
import { useBoardStore } from "@/stores/use-board-store";
import type { AiProviderKind, AudioRolePreset, FilmStatus } from "@/types/board";
import type { FilmAsset, FilmDocument } from "@/types/film";
import {
  fire,
  flushRenderer,
  hostButton,
  hostInput,
  hostNodes,
  hostSelect,
  installBrowser,
  nodeText,
  renderRenderer,
  restoreBrowser,
} from "@/test/react-renderer";
import { AudioRoleEditor } from "./AudioRoleEditor";
import { ImageToolbarPreferencesEditor } from "./ImageToolbarPreferencesEditor";
import { SettingsModal } from "./SettingsModal";
import { GenerationDefaultsEditor } from "./settings/GenerationDefaultsEditor";
import { ProviderRow } from "./settings/ProviderRow";
import { SettingsAccountSection } from "./settings/SettingsAccountSection";
import { SettingsDataSection } from "./settings/SettingsDataSection";
import { SettingsFeedbackBar } from "./settings/SettingsFeedbackBar";
import { SettingsGenerationSection } from "./settings/SettingsGenerationSection";
import { SettingsInterfaceSection } from "./settings/SettingsInterfaceSection";
import { SettingsModelsSection } from "./settings/SettingsModelsSection";
import { SettingsToolbarSection } from "./settings/SettingsToolbarSection";
import { AdvancedFilmToolsPanel } from "../film/AdvancedFilmToolsPanel";
import { AgentPanel, ProductionPanel, ProjectionPanel } from "../film/ProductionPanels";
import { DeliveryPanel, TimelinePanel } from "../film/TimelineDeliveryPanels";
import { AIDecompositionPanel, AIScriptPanel, AssetsPanel, ManuscriptPanel } from "../film/ManuscriptAssetsPanels";
import { MemoryRouter } from "react-router";

const NOW = "2026-08-19T00:00:00.000Z";

function response(value: unknown, status = 200): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withI18n(element: ReactElement): ReactElement {
  return <I18nProvider>{element}</I18nProvider>;
}

function capabilities(features: Partial<NonNullable<FilmStatus["capabilities"]["features"]>> = {}): FilmStatus["capabilities"] {
  return {
    available: true,
    reason: "",
    plainTextImport: true,
    markdownImport: true,
    docxImport: true,
    pdfImport: true,
    fileUploadImport: true,
    maxImportBytes: 50 * 1024 * 1024,
    stageGeneration: true,
    generationJobs: true,
    generationStages: ["storyboard", "first_frame", "audio", "video"],
    assetBundleExport: true,
    mp4Export: true,
    mp4Diagnostic: "",
    agentOperations: ["status", "next_steps", "validate"],
    features: {
      webdavMedia: false,
      advancedVoice: false,
      localWorkflows: false,
      styleExtraction: false,
      stageWaiver: false,
      ...features,
    },
  };
}

function filmStatus(projectId = "renderer-film", document = createFilmDocument(projectId, NOW)): FilmStatus {
  return { document, recordRevision: 1, capabilities: capabilities() };
}

let browserSnapshot: ReturnType<typeof installBrowser>;
let storeSnapshot: ReturnType<typeof useBoardStore.getState>;
let fetchSnapshot: typeof globalThis.fetch;
const activeRenderers: ReactTestRenderer[] = [];

beforeEach(() => {
  browserSnapshot = installBrowser();
  storeSnapshot = useBoardStore.getState();
  fetchSnapshot = globalThis.fetch;
  useBoardStore.setState({
    ready: true,
    config: createDefaultConfig(),
    setConfig: (config) => useBoardStore.setState({ config }),
  });
  const documentElement = globalThis.document.documentElement as unknown as {
    classList?: { toggle: (name: string, force?: boolean) => void };
    setAttribute?: (name: string, value: string) => void;
    style?: Record<string, unknown>;
  };
  documentElement.classList = { toggle: () => undefined };
  documentElement.setAttribute = () => undefined;
  documentElement.style = {};
  Object.assign(globalThis.window, {
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  });
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/media-capabilities")) {
      return response({ version: "a".repeat(64), models: [{
        channelId: "channel-1", channelName: "Renderer channel", protocol: "openai", model: "model-1", kind: "image",
        modes: ["text_to_image"], sizes: ["1024x1024"], ratios: [], resolutions: [], durations: [], maxReferences: 2,
      }] });
    }
    if (path.endsWith("/shared-channels")) return response([]);
    if (path.endsWith("/tenant/policy")) return response({ allowCustomChannel: true, allowCloudChannel: true });
    if (path.endsWith("/auth/password")) return response(undefined, 204);
    if (path.includes("/voice-identities") && path.endsWith("/voice-identities")) return response([]);
    if (path.includes("/voice-identities/") && (path.endsWith("/samples") || path.endsWith("/consents") || path.endsWith("/versions"))) return response([]);
    if (path.endsWith("/generation-jobs")) return response({ items: [], page: 1, pageSize: 100, total: 0 });
    if (path.includes("/film/") || path.includes("/films/")) return response({});
    return response({});
  };
});

afterEach(async () => {
  for (const renderer of activeRenderers.splice(0)) await fire(() => renderer.unmount());
  globalThis.fetch = fetchSnapshot;
  await fire(() => useBoardStore.setState(storeSnapshot, true));
  restoreBrowser(browserSnapshot);
});

async function loaded(element: ReactElement): Promise<ReactTestRenderer> {
  const renderer = await renderRenderer(withI18n(element));
  await flushRenderer();
  activeRenderers.push(renderer);
  return renderer;
}

function firstByAria(renderer: ReactTestRenderer, value: string): ReactTestInstance {
  const node = hostNodes(renderer, "input").concat(hostNodes(renderer, "select"), hostNodes(renderer, "textarea"), hostNodes(renderer, "button"))
    .find((candidate) => candidate.props["aria-label"] === value);
  if (!node) throw new Error(`missing aria label ${value}`);
  return node;
}

function defaultFilmDocument(projectId = "renderer-film"): FilmDocument {
  const document = createFilmDocument(projectId, NOW);
  document.source.text = "EPISODE 1\nINT. ROOM - DAY";
  return document;
}

describe("layout editors with real renderer events", () => {
  test("edits, adds and deletes audio roles while preserving immutable voice maps", async () => {
    let roles: AudioRolePreset[] = [{ id: "hero", name: "Hero", voices: { openai: "alloy" } }];
    function RoleHarness() {
      const [current, setCurrent] = useState(roles);
      return <AudioRoleEditor protocol="openai" roles={current} onChange={(next) => { roles = next; setCurrent(next); }} />;
    }
    const renderer = await loaded(<RoleHarness />);
    await fire(() => hostButton(renderer, "添加角色").props.onClick());
    expect(roles).toHaveLength(2);
    const name = hostInput(renderer, (node) => node.props.type !== "password" && String(node.props["aria-label"]).startsWith("Hero"));
    await fire(() => name.props.onChange({ target: { value: "  Lead character " } }));
    expect(roles[0]?.name).toBe("Lead character");
    await fire(() => name.props.onChange({ target: { value: "   " } }));
    await fire(() => name.props.onBlur());
    const voice = hostNodes(renderer, "select")[0]!;
    await fire(() => voice.props.onChange({ target: { value: "nova" } }));
    expect(roles[0]?.voices.openai).toBe("nova");
    const deleteButtons = hostNodes(renderer, "button").filter((node) => String(node.props["aria-label"]).includes("删除角色"));
    await fire(() => deleteButtons[0]!.props.onClick());
    expect(roles).toHaveLength(1);
    expect(roles[0]).not.toBe(undefined);
  });

  test("moves, hides, toggles labels, and resets image toolbar preferences", async () => {
    const changes: unknown[] = [];
    const renderer = await loaded(<ImageToolbarPreferencesEditor value={undefined} onChange={(next) => changes.push(next)} />);
    const labels = hostInput(renderer, (node) => node.props.type === "checkbox" && node.props.checked === true && !node.props.disabled);
    await fire(() => labels.props.onChange({ target: { checked: false } }));
    const actionCheckbox = hostInput(renderer, (node) => node.props.type === "checkbox" && String(node.props["aria-label"]).includes("生成"));
    await fire(() => actionCheckbox.props.onChange({ target: { checked: false } }));
    const down = hostNodes(renderer, "button").find((node) => String(node.props["aria-label"]).startsWith("下移"))!;
    await fire(() => down.props.onClick());
    const up = hostNodes(renderer, "button").find((node) => String(node.props["aria-label"]).startsWith("上移"))!;
    await fire(() => up.props.onClick());
    await fire(() => hostButton(renderer, "恢复默认").props.onClick());
    expect(changes.length).toBeGreaterThanOrEqual(5);
    expect((changes.at(-1) as { hidden: string[] }).hidden).toEqual([]);
  });

  test("clamps generation defaults and updates every interactive field", async () => {
    const changes: GenerationDefaults[] = [];
    const value: GenerationDefaults = {
      ...DEFAULT_GENERATION_DEFAULTS,
      videoSeconds: 8,
      audioSpeed: 1,
      audioInstructions: "",
      audioVoice: "unknown-voice",
    };
    const renderer = await loaded(<GenerationDefaultsEditor value={value} audioProtocol="openai" onChange={(next) => changes.push(next)} />);
    const selects = hostNodes(renderer, "select");
    await fire(() => selects[0]!.props.onChange({ target: { value: "9:16" } }));
    await fire(() => selects[1]!.props.onChange({ target: { value: "720p" } }));
    const numberInputs = hostNodes(renderer, "input").filter((node) => node.props.type === "number");
    await fire(() => numberInputs[0]!.props.onChange({ target: { value: "99" } }));
    await fire(() => hostNodes(renderer, "select")[2]!.props.onChange({ target: { value: "wav" } }));
    await fire(() => hostNodes(renderer, "select")[3]!.props.onChange({ target: { value: "alloy" } }));
    await fire(() => numberInputs.at(-1)!.props.onChange({ target: { value: "99" } }));
    await fire(() => hostNodes(renderer, "button").find((node) => node.props.role === "switch" && String(node.props["aria-label"]).includes("生成"))!.props.onClick());
    await fire(() => hostNodes(renderer, "button").find((node) => node.props.role === "switch" && String(node.props["aria-label"]).includes("水印"))!.props.onClick());
    const instruction = hostInput(renderer, (node) => node.props["aria-label"]?.includes("指令"));
    await fire(() => instruction.props.onChange({ target: { value: "Speak softly" } }));
    expect(changes.length).toBeGreaterThanOrEqual(9);
    expect(changes.some((next) => next.videoSeconds === 15)).toBe(true);
    expect(changes.some((next) => next.audioSpeed === 4)).toBe(true);
  });

  test("applies valid provider templates and reports malformed template JSON", async () => {
    const channel = createDefaultChannel();
    channel.providers!.image = {
      ...channel.providers!.image,
      protocol: "template",
      template: undefined,
      models: ["template-model"],
    };
    const patches: Array<Record<string, unknown>> = [];
    const provider = { ...channel.providers!.image, protocol: "template" as const };
    expect(provider.protocol).toBe("template");
    const renderer = await loaded(<ProviderRow kind="image" provider={provider} models={["template-model"]} busy={false} disabled={false} onPull={() => undefined} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
    const template = hostNodes(renderer, "textarea")[0]!;
    await fire(() => template.props.onChange({ target: { value: "{" } }));
    await fire(() => hostButton(renderer, "应用模板").props.onClick());
    expect(nodeText(renderer.root)).toContain("JSON Parse error");
    const valid = JSON.stringify({ method: "POST", path: "/render", auth: "bearer", request: { prompt: "{{prompt}}" }, responsePath: "url" });
    await fire(() => template.props.onChange({ target: { value: valid } }));
    await fire(() => hostButton(renderer, "应用模板").props.onClick());
    expect(patches.some((patch) => patch.template)).toBe(true);
    await fire(() => hostButton(renderer, "template-model").props.onClick());
    await fire(() => hostNodes(renderer, "input").find((node) => String(node.props["aria-label"]).includes("URL"))!.props.onChange({ target: { value: "https://image.example" } }));
    expect(patches.length).toBeGreaterThan(2);
  });

  test("changes interface theme with click, keyboard navigation, and locale", async () => {
    const renderer = await loaded(<SettingsInterfaceSection />);
    const themeButtons = hostNodes(renderer, "button").filter((node) => node.props.role === "radio");
    await fire(() => themeButtons.find((node) => node.props.id === "theme-opt-dark")!.props.onClick());
    await fire(() => themeButtons.find((node) => node.props.id === "theme-opt-dark")!.props.onKeyDown({ key: "ArrowRight", preventDefault: () => undefined }));
    await fire(() => themeButtons.find((node) => node.props.id === "theme-opt-system")!.props.onKeyDown({ key: "ArrowLeft", preventDefault: () => undefined }));
    await flushRenderer();
    await fire(() => hostSelect(renderer, (node) => Boolean(node.props["aria-label"])).props.onChange({ target: { value: "en-US" } }));
    expect(useBoardStore.getState().config.theme).toBe("dark");
  });

  test("renders feedback states and usage refresh chrome", async () => {
    const renderer = await loaded(<SettingsFeedbackBar error="broken" feedback={{ tone: "success", message: "saved" }} />);
    expect(nodeText(renderer.root)).toContain("broken");
    expect(nodeText(renderer.root)).toContain("saved");
    const empty = await loaded(<SettingsFeedbackBar error={null} feedback={null} />);
    expect(empty.root.findByProps({ hidden: true })).toBeDefined();
  });
});
