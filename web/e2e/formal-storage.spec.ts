import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server as HTTPServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

const generatedPNG = readFileSync(new URL("../../docs/screenshots/openboard-canvas.png", import.meta.url)).toString("base64");
const generatedMP4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]);
const generatedMP3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
let imageUpstream: HTTPServer;
let imageUpstreamURL = "";
let releaseImage: (() => void) | undefined;
let notifyImageStarted: (() => void) | undefined;
let imageProviderRequest: { authorization: string; body: unknown } | undefined;
let releaseVideo: (() => void) | undefined;
let notifyVideoStarted: (() => void) | undefined;
let videoProviderRequest: { authorization: string; body: unknown } | undefined;
let audioProviderRequest: { authorization: string; body: unknown } | undefined;
let geminiProviderRequests: Array<{ apiKey: string; body: unknown }> = [];
let releaseGemini: (() => void) | undefined;
let notifyGeminiStarted: (() => void) | undefined;
let blockGemini = false;
let templateProviderRequest: { apiKey: string; body: unknown } | undefined;
let releaseTemplate: (() => void) | undefined;
let notifyTemplateStarted: (() => void) | undefined;
let blockTemplate = false;
let templateVideoProviderRequest: { apiKey: string; body: unknown } | undefined;
let releaseTemplateVideo: (() => void) | undefined;
let notifyTemplateVideoStarted: (() => void) | undefined;
let blockTemplateVideo = false;

function releasePendingImageRequest() {
  const release = releaseImage;
  releaseImage = undefined;
  release?.();
}

async function settleInitialSurface(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTitle("设置")).toBeVisible();
  await page.getByTitle("设置").click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings.getByLabel("当前渠道")).not.toHaveValue("");
  await settings.getByRole("button", { name: "关闭设置" }).click();
}

async function waitForFormalChannel(
  request: APIRequestContext,
  channelId: string,
  expectedSecret: string,
) {
  await expect.poll(async () => {
    const response = await request.get("/api/state/config");
    if (!response.ok()) return false;
    const config = await response.json() as { channels?: Array<{ id?: string }> };
    return config.channels?.some((channel) => channel.id === channelId) ?? false;
  }).toBe(true);
  await expect.poll(async () => {
    const response = await request.get("/api/secrets/config");
    return response.ok() ? JSON.stringify(await response.json()).includes(expectedSecret) : false;
  }).toBe(true);
}

async function saveFormalConfig(
  request: APIRequestContext,
  config: unknown,
  apiKeys: Record<string, Record<string, string>>,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await request.get("/api/config");
    const headers: Record<string, string> = {};
    if (current.status() === 404) {
      headers["If-None-Match"] = "*";
    } else {
      await expect(current).toBeOK();
      const etag = current.headers().etag;
      expect(etag).toBeTruthy();
      headers["If-Match"] = etag;
    }
    const saved = await request.put("/api/config", {
      headers,
      data: { config, secrets: { apiKeys, webdavPass: "" } },
    });
    if (saved.status() === 204) return;
    if (saved.status() !== 412 || attempt === 2) {
      expect(saved.status()).toBe(204);
    }
  }
  throw new Error("Config save exhausted its bounded conflict retries");
}

async function openHydratedSurface(page: Page, path: string, channelId: string) {
  await page.goto(path);
  await expect(page.getByTitle("设置")).toBeVisible();
  await page.getByTitle("设置").click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings.getByLabel("当前渠道")).toHaveValue(`personal:${channelId}`);
  await settings.getByRole("button", { name: "关闭设置" }).click();
}

test.beforeAll(async () => {
  imageUpstream = createServer(async (incoming, response) => {
	if (incoming.method === "GET" && incoming.url === "/v1/videos/formal-video/content") {
	  response.writeHead(200, { "Content-Type": "video/mp4" });
	  response.end(generatedMP4);
	  return;
	}
	if (incoming.method === "GET" && incoming.url === "/template-video-result.mp4?signature=read-only") {
	  response.writeHead(200, { "Content-Type": "video/mp4" });
	  response.end(generatedMP4);
	  return;
	}
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
	if (incoming.method === "POST" && incoming.url === "/v1beta/models/gemini-image:generateContent") {
	  geminiProviderRequests.push({
		apiKey: String(incoming.headers["x-goog-api-key"] ?? ""),
		body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
	  });
	  notifyGeminiStarted?.();
	  if (blockGemini) await new Promise<void>((resolve) => { releaseGemini = resolve; });
	  response.writeHead(200, { "Content-Type": "application/json" });
	  response.end(JSON.stringify({ candidates: [{ content: { parts: [
		{ text: "generated" },
		{ inlineData: { mimeType: "image/png", data: generatedPNG } },
	  ] } }] }));
	  return;
	}
	if (incoming.method === "PUT" && incoming.url === "/v1/template-render") {
	  templateProviderRequest = {
		apiKey: String(incoming.headers["x-api-key"] ?? ""),
		body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
	  };
	  notifyTemplateStarted?.();
	  if (blockTemplate) await new Promise<void>((resolve) => { releaseTemplate = resolve; });
	  response.writeHead(200, { "Content-Type": "application/json" });
	  response.end(JSON.stringify({ output: { images: [`data:image/png;base64,${generatedPNG}`] } }));
	  return;
	}
	if (incoming.method === "PUT" && incoming.url === "/v1/template-video") {
	  templateVideoProviderRequest = {
		apiKey: String(incoming.headers["x-api-key"] ?? ""),
		body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
	  };
	  notifyTemplateVideoStarted?.();
	  if (blockTemplateVideo) await new Promise<void>((resolve) => { releaseTemplateVideo = resolve; });
	  response.writeHead(200, { "Content-Type": "application/json" });
	  const host = String(incoming.headers.host ?? "127.0.0.1");
	  response.end(JSON.stringify({ output: { url: `http://${host}/template-video-result.mp4?signature=read-only` } }));
	  return;
	}
	if (incoming.method === "POST" && incoming.url === "/v1/videos") {
	  videoProviderRequest = {
		authorization: incoming.headers.authorization ?? "",
		body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
	  };
	  notifyVideoStarted?.();
	  await new Promise<void>((resolve) => { releaseVideo = resolve; });
	  response.writeHead(200, { "Content-Type": "application/json" });
	  response.end(JSON.stringify({ id: "formal-video", status: "completed" }));
	  return;
	}
	if (incoming.method === "POST" && incoming.url === "/v1/audio/speech") {
	  audioProviderRequest = {
		authorization: incoming.headers.authorization ?? "",
		body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
	  };
	  response.writeHead(200, { "Content-Type": "audio/mpeg" });
	  response.end(generatedMP3);
	  return;
	}
	if (incoming.method !== "POST" || (incoming.url !== "/v1/images/generations" && incoming.url !== "/v1/images/edits")) {
	  response.writeHead(404).end();
	  return;
	}
    imageProviderRequest = {
      authorization: incoming.headers.authorization ?? "",
      body: incoming.url === "/v1/images/generations"
        ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
        : Buffer.concat(chunks).toString("utf8"),
    };
    notifyImageStarted?.();
    await new Promise<void>((resolve) => { releaseImage = resolve; });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: generatedPNG }] }));
  });
  await new Promise<void>((resolve) => imageUpstream.listen(0, "127.0.0.1", resolve));
  const address = imageUpstream.address() as AddressInfo;
  imageUpstreamURL = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  releasePendingImageRequest();
	releaseVideo?.();
	releaseGemini?.();
	releaseTemplate?.();
	releaseTemplateVideo?.();
  await new Promise<void>((resolve) => imageUpstream.close(() => resolve()));
});

test("formal restricted Template image jobs survive reload", async ({ page, request }) => {
  const template = {
    method: "PUT", path: "/template-render", auth: "x-api-key",
    request: { prompt: "{{prompt}}", model: "{{model}}", count: "{{count}}" },
    responsePath: "output.images",
  };
  const provider = {
    baseUrl: imageUpstreamURL, apiKey: "", model: "relay-image", protocol: "template", template,
  };
  const config = {
    channels: [{
      id: "formal-template", name: "Formal Template", baseUrl: imageUpstreamURL, apiKey: "",
      defaultTextModel: "relay-text", defaultImageModel: "relay-image",
      defaultVideoModel: "relay-video", defaultAudioModel: "relay-audio",
      providers: {
        text: { ...provider, protocol: "openai", model: "relay-text", template: undefined },
        image: provider,
        video: { ...provider, protocol: "openai", model: "relay-video", template: undefined },
        audio: { ...provider, protocol: "openai", model: "relay-audio", template: undefined },
      },
    }],
    activeChannelId: "formal-template", systemPrompt: "formal template rule",
    imageSize: "1024x1024", imageQuality: "auto", imageCount: 1, theme: "light",
  };
  await page.goto("/workbench/image");
  await expect(page.getByTitle("设置")).toBeVisible();
  // Let the initial server hydrate and any default-workspace writes settle
  // before seeding credentials through the formal API client.
  await page.waitForTimeout(500);
  await saveFormalConfig(request, config, {
    "formal-template": { image: "template-formal-secret" },
  });
  await openHydratedSurface(page, "/workbench/image", "formal-template");
  await expect.poll(async () => {
    const response = await request.get("/api/secrets/config");
    return response.ok() ? JSON.stringify(await response.json()).includes("template-formal-secret") : false;
  }).toBe(true);
  templateProviderRequest = undefined;
  blockTemplate = true;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  notifyTemplateStarted = startedResolve;

  await page.getByRole("combobox", { name: "分类", exact: true }).fill("正式模板");
  await page.getByPlaceholder("描述想生成的图片…").fill("durable restricted template");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await Promise.race([
    started,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Template provider was not called")), 15_000)),
  ]);
  expect(templateProviderRequest).toEqual({
    apiKey: "template-formal-secret",
    body: { prompt: "formal template rule\n\ndurable restricted template", model: "relay-image", count: 1 },
  });
  let card = page.locator("article").filter({ hasText: "durable restricted template" });
  await expect(card.getByText("进行中", { exact: false })).toBeVisible();
  await page.reload();
  card = page.locator("article").filter({ hasText: "durable restricted template" });
  await expect(card.getByText("进行中", { exact: false })).toBeVisible();
  blockTemplate = false;
  releaseTemplate?.();
  releaseTemplate = undefined;
  await expect(card.getByText("成功", { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("正式模板");
  await expect(card).toContainText(/\d+(?:\.\d+)? (?:KB|MB)/);
  await page.getByLabel("生成历史分类").selectOption("正式模板");
  await expect(card).toBeVisible();

  const jobsResponse = await request.get("/api/generation-jobs?kind=image&page=1&pageSize=20");
  const jobs = await jobsResponse.json() as { items: Array<{ id: string; prompt: string; status: string; parameters: { category?: string }; result: { items?: Array<{ storageKey: string }> } }> };
  const job = jobs.items.find((item) => item.prompt === "durable restricted template");
  expect(job).toMatchObject({ status: "succeeded", parameters: { category: "正式模板" } });
  const storageKey = job?.result.items?.[0]?.storageKey;
  expect(storageKey).toBeTruthy();
  const blob = await request.get(`/api/blobs/${encodeURIComponent(storageKey!)}`);
  await expect(blob).toBeOK();
  expect(Buffer.from(await blob.body()).toString("base64")).toBe(generatedPNG);
  if (storageKey) expect((await request.delete(`/api/blobs/${encodeURIComponent(storageKey)}`)).status()).toBe(204);
  if (job) expect((await request.delete(`/api/generation-jobs/${encodeURIComponent(job.id)}`)).status()).toBe(204);
  notifyTemplateStarted = undefined;
});

test("formal restricted Template video jobs survive reload", async ({ page, request }) => {
  const template = {
    method: "PUT", path: "/template-video", auth: "x-api-key",
    request: {
      prompt: "{{prompt}}", model: "{{model}}", duration: "{{duration}}",
      ratio: "{{ratio}}", resolution: "{{resolution}}",
      images: "{{referenceImages}}", videos: "{{referenceVideos}}", audios: "{{referenceAudios}}",
    },
    responsePath: "output.url",
  };
  const videoProvider = {
    baseUrl: imageUpstreamURL, apiKey: "", model: "relay-video", protocol: "template", template,
  };
  const openAIProvider = { baseUrl: imageUpstreamURL, apiKey: "", protocol: "openai" };
  const config = {
    channels: [{
      id: "formal-template-video", name: "Formal Template Video", baseUrl: imageUpstreamURL, apiKey: "",
      defaultTextModel: "relay-text", defaultImageModel: "relay-image",
      defaultVideoModel: "relay-video", defaultAudioModel: "relay-audio",
      providers: {
        text: { ...openAIProvider, model: "relay-text" },
        image: { ...openAIProvider, model: "relay-image" },
        video: videoProvider,
        audio: { ...openAIProvider, model: "relay-audio" },
      },
    }],
    activeChannelId: "formal-template-video", systemPrompt: "formal template video rule",
    imageSize: "1024x1024", imageQuality: "auto", imageCount: 1, theme: "light",
  };
  await settleInitialSurface(page, "/workbench/video");
  await saveFormalConfig(request, config, {
    "formal-template-video": { video: "template-video-secret" },
  });
  await waitForFormalChannel(request, "formal-template-video", "template-video-secret");
  templateVideoProviderRequest = undefined;
  blockTemplateVideo = true;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  notifyTemplateVideoStarted = startedResolve;

  await openHydratedSurface(page, "/workbench/video", "formal-template-video");
  await page.getByPlaceholder("描述想生成的视频…").fill("durable restricted template video");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await Promise.race([
    started,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Template video provider was not called")), 15_000)),
  ]);
  expect(templateVideoProviderRequest).toEqual({
    apiKey: "template-video-secret",
    body: {
      prompt: "formal template video rule\n\ndurable restricted template video",
      model: "relay-video", duration: 5, ratio: "16:9", resolution: "720p",
      images: [], videos: [], audios: [],
    },
  });
  let card = page.locator("article").filter({ hasText: "durable restricted template video" });
  await expect(card.getByText("进行中", { exact: false })).toBeVisible();
  await page.reload();
  card = page.locator("article").filter({ hasText: "durable restricted template video" });
  await expect(card.getByText("进行中", { exact: false })).toBeVisible();
  blockTemplateVideo = false;
  releaseTemplateVideo?.();
  releaseTemplateVideo = undefined;
  await expect(card.getByText("成功", { exact: false })).toBeVisible({ timeout: 20_000 });

  const jobsResponse = await request.get("/api/generation-jobs?kind=video&page=1&pageSize=20");
  const jobs = await jobsResponse.json() as { items: Array<{ id: string; prompt: string; status: string; result: { items?: Array<{ storageKey: string }> } }> };
  const job = jobs.items.find((item) => item.prompt === "durable restricted template video");
  expect(job).toMatchObject({ status: "succeeded" });
  const storageKey = job?.result.items?.[0]?.storageKey;
  expect(storageKey).toBeTruthy();
  const blob = await request.get(`/api/blobs/${encodeURIComponent(storageKey!)}`);
  await expect(blob).toBeOK();
  expect(Buffer.from(await blob.body())).toEqual(generatedMP4);
  if (storageKey) expect((await request.delete(`/api/blobs/${encodeURIComponent(storageKey)}`)).status()).toBe(204);
  if (job) expect((await request.delete(`/api/generation-jobs/${encodeURIComponent(job.id)}`)).status()).toBe(204);
  notifyTemplateVideoStarted = undefined;
});

test("formal Gemini canvas image batches survive reload", async ({ page, request }) => {
  await expect.poll(async () => (await (await request.get("/api/projects")).json() as unknown[]).length).toBeGreaterThan(0);
  const summaries = await (await request.get("/api/projects")).json() as Array<{ id: string }>;
  const projectId = summaries[0]!.id;
  const baseline = await (await request.get(`/api/projects/${encodeURIComponent(projectId)}`)).json() as Record<string, unknown>;
  const geminiBaseURL = imageUpstreamURL.replace(/\/v1$/, "/v1beta");
  const provider = { baseUrl: geminiBaseURL, apiKey: "", model: "gemini-image", protocol: "gemini" as const };
  const config = {
    channels: [{
      id: "formal-gemini", name: "Formal Gemini", baseUrl: geminiBaseURL, apiKey: "",
      defaultTextModel: "gemini-text", defaultImageModel: "gemini-image",
      defaultVideoModel: "sora-2", defaultAudioModel: "tts",
      providers: { text: { ...provider, model: "gemini-text" }, image: provider,
        video: { ...provider, protocol: "openai", model: "sora-2" },
        audio: { ...provider, protocol: "openai", model: "tts" } },
    }],
    activeChannelId: "formal-gemini", systemPrompt: "formal system image rule",
    imageSize: "1024x1024", imageQuality: "auto", imageCount: 2, theme: "light",
  };
  await saveFormalConfig(request, config, {
    "formal-gemini": { image: "gemini-formal-secret" },
  });
  geminiProviderRequests = [];
  blockGemini = true;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  notifyGeminiStarted = startedResolve;

  await openHydratedSurface(page, "/", "formal-gemini");
  const toolbar = page.getByRole("toolbar", { name: "画布工具栏" });
  await toolbar.getByRole("button", { name: "图片", exact: true }).click();
  const root = page.locator('[data-node-type="image"]').last();
  const rootId = await root.getAttribute("data-node-id");
  expect(rootId).toBeTruthy();
  await root.locator("[data-node-header]").click();
  const promptInput = root.getByRole("textbox", { name: "节点生成提示词" });
  await expect(promptInput).toBeVisible();
  await promptInput.fill("durable Gemini canvas batch");
  await root.getByRole("button", { name: "发送提示词", exact: true }).click();
  try {
    await Promise.race([
      started,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Gemini provider was not called")), 15_000)),
    ]);
  } catch (error) {
    const diagnosticJobs = await (await request.get("/api/generation-jobs?kind=image&page=1&pageSize=20")).text();
    const diagnosticProject = await (await request.get(`/api/projects/${encodeURIComponent(projectId)}`)).text();
    throw new Error(`${error instanceof Error ? error.message : "Gemini provider was not called"}; jobs=${diagnosticJobs}; project=${diagnosticProject}`);
  }
  expect(geminiProviderRequests[0]).toMatchObject({
    apiKey: "gemini-formal-secret",
    body: {
      contents: [{ role: "user", parts: [{ text: "formal system image rule\n\ndurable Gemini canvas batch" }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    },
  });
  let jobId = "";
  await expect.poll(async () => {
    const response = await request.get("/api/generation-jobs?kind=image&page=1&pageSize=20");
    const jobs = await response.json() as {
      items: Array<{ id: string; prompt: string; parameters?: { count?: number } }>;
    };
    const job = jobs.items.find((item) =>
      item.prompt === "formal system image rule\n\ndurable Gemini canvas batch" ||
      item.prompt === "durable Gemini canvas batch");
    jobId = job?.id ?? "";
    return job?.parameters?.count;
  }).toBe(2);
  const persistedPlaceholderIndexes = async () => {
    const response = await request.get(`/api/projects/${encodeURIComponent(projectId)}`);
    const project = await response.json() as {
      nodes?: Array<{ metadata?: { generationJobId?: string; generationResultIndex?: number } }>;
    };
    return [...new Set(project.nodes
      ?.filter((item) =>
        item.metadata?.generationJobId === jobId &&
        Number.isInteger(item.metadata.generationResultIndex))
      .map((item) => item.metadata!.generationResultIndex!) ?? [])]
      .sort((left, right) => left - right)
      .join(",");
  };
  await expect.poll(persistedPlaceholderIndexes).toBe("0,1");
  await page.reload();
  await expect.poll(persistedPlaceholderIndexes).toBe("0,1");
  blockGemini = false;
  releaseGemini?.();
  releaseGemini = undefined;

  await expect.poll(async () => {
    const jobs = await (await request.get("/api/generation-jobs?kind=image&page=1&pageSize=20")).json() as {
      items: Array<{ id: string; status: string }>;
    };
    return jobs.items.find((item) => item.id === jobId)?.status;
  }, { timeout: 20_000 }).toBe("succeeded");
  const jobsResponse = await request.get("/api/generation-jobs?kind=image&page=1&pageSize=20");
  const jobs = await jobsResponse.json() as { items: Array<{ id: string; prompt: string; status: string; result: { items?: Array<{ storageKey: string }> } }> };
  const job = jobs.items.find((item) => item.id === jobId);
  expect(job).toMatchObject({ id: jobId, status: "succeeded" });
  expect(job?.result.items).toHaveLength(2);
  const resultStorageKeys = [...new Set(job?.result.items?.map(({ storageKey }) => storageKey) ?? [])].sort();
  expect(resultStorageKeys).toHaveLength(2);
  expect(geminiProviderRequests).toHaveLength(2);
  await page.reload();
  await expect.poll(async () => {
    const response = await request.get(`/api/projects/${encodeURIComponent(projectId)}`);
    const project = await response.json() as {
      nodes?: Array<{ metadata?: { generationJobId?: string; storageKey?: string } }>;
    };
    return [...new Set(project.nodes
      ?.filter((item) =>
        item.metadata?.generationJobId === jobId && Boolean(item.metadata.storageKey))
      .map((item) => item.metadata!.storageKey!) ?? [])].sort();
  }).toEqual(resultStorageKeys);

  expect((await request.put(`/api/projects/${encodeURIComponent(projectId)}`, { data: baseline })).status()).toBe(204);
  for (const item of job?.result.items ?? []) expect((await request.delete(`/api/blobs/${encodeURIComponent(item.storageKey)}`)).status()).toBe(204);
  if (job) expect((await request.delete(`/api/generation-jobs/${encodeURIComponent(job.id)}`)).status()).toBe(204);
  notifyGeminiStarted = undefined;
});

test("formal director captures synchronize through protected storage", async ({ page, request, browser }) => {
  await page.goto("/");
  await expect.poll(async () => {
    const response = await request.get("/api/projects");
    return (await response.json() as Array<unknown>).length;
  }).toBeGreaterThan(0);
  const projectsResponse = await request.get("/api/projects");
  const projects = await projectsResponse.json() as Array<{ id: string }>;
  const baselines = new Map<string, { id: string; title: string; nodes?: Array<{ id: string; type: string }> }>();
  for (const project of projects) {
    const response = await request.get(`/api/projects/${encodeURIComponent(project.id)}`);
    baselines.set(project.id, await response.json() as { id: string; title: string; nodes?: Array<{ id: string; type: string }> });
  }

  const toolbar = page.getByRole("toolbar", { name: "画布工具栏" });
  await toolbar.getByRole("button", { name: "导演台", exact: true }).click();
  const directorNode = page.locator('[data-node-type="director"]').last();
  const directorId = await directorNode.getAttribute("data-node-id");
  expect(directorId).toBeTruthy();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  let dialog = page.getByRole("dialog", { name: "3D 导演台" });
  await expect(dialog.getByText("拍摄后会保存到受保护存储，并在登录设备间同步。", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "拍摄当前机位" }).click();
  await expect(dialog.getByText("同步截图 · 1", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole("list", { name: "同步截图列表" }).getByRole("listitem")).toHaveCount(1);
  await dialog.getByRole("button", { name: "关闭导演台" }).click();

  let projectId = "";
  await expect.poll(async () => {
    const response = await request.get("/api/director-captures");
    const records = await response.json() as Array<{ projectId: string; directorNodeId: string }>;
    projectId = records.find((record) => record.directorNodeId === directorId)?.projectId ?? "";
    return projectId;
  }).not.toBe("");
  const baseline = baselines.get(projectId)!;
  const capturesResponse = await request.get(`/api/director-captures?projectId=${encodeURIComponent(projectId)}&directorNodeId=${encodeURIComponent(directorId)}`);
  await expect(capturesResponse).toBeOK();
  const captures = await capturesResponse.json() as Array<{ id: string; url: string; mimeType: string; bytes: number }>;
  expect(captures).toHaveLength(1);
  expect(captures[0]).toMatchObject({ mimeType: "image/png" });
  const protectedImage = await request.get(captures[0]!.url);
  await expect(protectedImage).toBeOK();
  expect(protectedImage.headers()["content-type"]).toContain("image/png");
  expect((await protectedImage.body()).byteLength).toBe(captures[0]!.bytes);

  await page.reload();
  await page.locator(`[data-node-id="${directorId}"]`).getByRole("button", { name: "打开导演台" }).click();
  dialog = page.getByRole("dialog", { name: "3D 导演台" });
  await expect(dialog.getByText("同步截图 · 1", { exact: true })).toBeVisible();

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  try {
    await secondPage.goto("/");
    const secondDirector = secondPage.locator(`[data-node-id="${directorId}"]`);
    await expect(secondDirector).toBeVisible();
    await secondDirector.getByRole("button", { name: "打开导演台" }).click();
    const secondDialog = secondPage.getByRole("dialog", { name: "3D 导演台" });
    await expect(secondDialog.getByText("同步截图 · 1", { exact: true })).toBeVisible();
    await secondDialog.getByLabel(/选择截图/).check();
    await secondDialog.getByRole("button", { name: "删除选中" }).click();
    await expect(secondDialog.getByText("同步截图 · 0", { exact: true })).toBeVisible();
  } finally {
    await secondContext.close();
  }
  await expect.poll(async () => {
    const response = await request.get(`/api/director-captures?projectId=${encodeURIComponent(projectId)}&directorNodeId=${encodeURIComponent(directorId)}`);
    return (await response.json() as unknown[]).length;
  }).toBe(0);
  expect((await request.get(captures[0]!.url)).status()).toBe(404);

  expect((await request.put(`/api/projects/${encodeURIComponent(projectId)}`, { data: baseline })).status()).toBe(204);
});

test("formal video and canvas audio jobs survive the browser executor boundary", async ({ page, request }) => {
	await page.goto("/");
	await expect(page.getByRole("toolbar", { name: "画布工具栏" })).toBeVisible();
	await expect.poll(async () => {
		const response = await request.get("/api/projects");
		return (await response.json() as Array<unknown>).length;
	}).toBeGreaterThan(0);
	const baselineProjectsResponse = await request.get("/api/projects");
	const baselineProjects = await baselineProjectsResponse.json() as Array<{ id: string }>;
	const baselineProjectId = baselineProjects[0]!.id;
	const baselineProjectResponse = await request.get(`/api/projects/${encodeURIComponent(baselineProjectId)}`);
	const baselineProject = await baselineProjectResponse.json() as Record<string, unknown>;
	const provider = { baseUrl: imageUpstreamURL, apiKey: "", protocol: "openai" as const };
	const config = {
		channels: [{
			id: "formal-media", name: "Formal media", baseUrl: imageUpstreamURL, apiKey: "",
			defaultTextModel: "gpt-4o-mini", defaultImageModel: "gpt-image-1",
			defaultVideoModel: "sora-2", defaultAudioModel: "gpt-4o-mini-tts",
			providers: {
				text: { ...provider, model: "gpt-4o-mini" }, image: { ...provider, model: "gpt-image-1" },
				video: { ...provider, model: "sora-2" }, audio: { ...provider, model: "gpt-4o-mini-tts" },
			},
		}],
		activeChannelId: "formal-media", systemPrompt: "", imageSize: "1024x1024",
		imageQuality: "auto", imageCount: 1, theme: "light",
	};
	await saveFormalConfig(request, config, {
		"formal-media": { video: "sk-video-formal", audio: "sk-audio-formal" },
	});

	let videoStartedResolve: (() => void) | undefined;
	const videoStarted = new Promise<void>((resolve) => { videoStartedResolve = resolve; });
	notifyVideoStarted = videoStartedResolve;
	await openHydratedSurface(page, "/workbench/video", "formal-media");
	await page.getByPlaceholder("描述想生成的视频…").fill("durable formal video");
	await page.getByRole("button", { name: "生成", exact: true }).click();
	await Promise.race([
		videoStarted,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mock video provider was not called")), 15_000)),
	]);
	expect(videoProviderRequest).toMatchObject({
		authorization: "Bearer sk-video-formal",
		body: { model: "sora-2", prompt: "durable formal video", seconds: 5 },
	});
	let card = page.locator("article").filter({ hasText: "durable formal video" });
	await expect(card.getByText("进行中", { exact: false })).toBeVisible();
	await page.reload();
	card = page.locator("article").filter({ hasText: "durable formal video" });
	await expect(card.getByText("进行中", { exact: false })).toBeVisible();
	releaseVideo?.();
	releaseVideo = undefined;
	await expect(card.getByText("成功", { exact: false })).toBeVisible({ timeout: 15_000 });
	const videoJobs = await request.get("/api/generation-jobs?kind=video&page=1&pageSize=20");
	const videoPage = await videoJobs.json() as { items: Array<{ id: string; prompt: string; result: { items?: Array<{ storageKey?: string }> } }> };
	const videoJob = videoPage.items.find((item) => item.prompt === "durable formal video");
	const videoKey = videoJob?.result.items?.[0]?.storageKey;
	expect(videoKey).toBeTruthy();
	const videoBlob = await request.get(`/api/blobs/${encodeURIComponent(videoKey!)}`);
	await expect(videoBlob).toBeOK();
	expect(Buffer.from(await videoBlob.body())).toEqual(generatedMP4);

	await page.goto("/");
	await page.getByRole("toolbar", { name: "画布工具栏" }).getByTitle("音频", { exact: true }).click();
	const audioNode = page.locator('[data-node-type="audio"]').last();
	await audioNode.locator("[data-node-header]").click();
	const audioPrompt = audioNode.getByRole("textbox", { name: "节点生成提示词" });
	await audioPrompt.fill("durable canvas narration");
	await audioPrompt.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
	await expect(page.locator("audio")).toHaveCount(1, { timeout: 15_000 });
	expect(audioProviderRequest).toMatchObject({
		authorization: "Bearer sk-audio-formal",
		body: { model: "gpt-4o-mini-tts", input: "durable canvas narration", voice: "alloy", response_format: "mp3" },
	});
	await page.reload();
	await expect(page.locator("audio")).toHaveCount(1, { timeout: 15_000 });
	const audioJobs = await request.get("/api/generation-jobs?kind=audio&page=1&pageSize=20");
	const audioPage = await audioJobs.json() as { items: Array<{ id: string; prompt: string; status: string; result: { items?: Array<{ storageKey?: string }> } }> };
	const audioJob = audioPage.items.find((item) => item.prompt === "durable canvas narration");
	expect(audioJob).toMatchObject({ status: "succeeded" });
	const audioKey = audioJob?.result.items?.[0]?.storageKey;

	// Restore the exact project and remove this test's terminal jobs/media so
	// later formal scenarios remain order-independent.
	await page.goto("/workbench/video");
	expect((await request.put(`/api/projects/${encodeURIComponent(baselineProjectId)}`, { data: baselineProject })).status()).toBe(204);
	for (const key of [videoKey, audioKey]) {
		if (key) expect((await request.delete(`/api/blobs/${encodeURIComponent(key)}`)).status()).toBe(204);
	}
	for (const id of [videoJob?.id, audioJob?.id]) {
		if (id) expect((await request.delete(`/api/generation-jobs/${encodeURIComponent(id)}`)).status()).toBe(204);
	}
});

test("formal local runtime persists projects, blobs, state, and Agent access", async ({ page, request }) => {
  await page.route("https://formal-prompts.example/catalog.json", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ payload: { entries: [{ label: "Formal prompt", value: "persisted prompt source body" }] } }),
  }));

  const provider = { baseUrl: imageUpstreamURL, apiKey: "", model: "gpt-image-1", protocol: "openai" };
  const config = {
    channels: [{
      id: "formal-image", name: "Formal image", baseUrl: imageUpstreamURL, apiKey: "",
      defaultTextModel: "gpt-4o-mini", defaultImageModel: "gpt-image-1",
      defaultVideoModel: "sora-2", defaultAudioModel: "gpt-4o-mini-tts",
      providers: {
        text: { ...provider, model: "gpt-4o-mini" }, image: provider,
        video: { ...provider, model: "sora-2" }, audio: { ...provider, model: "gpt-4o-mini-tts" },
      },
    }],
    activeChannelId: "formal-image", systemPrompt: "", imageSize: "1024x1024",
    imageQuality: "auto", imageCount: 1, theme: "light",
  };
  await settleInitialSurface(page, "/workbench/image");
  await saveFormalConfig(request, config, {
    "formal-image": { image: "sk-formal-private" },
  });
  await waitForFormalChannel(request, "formal-image", "sk-formal-private");

  let imageStartedResolve: (() => void) | undefined;
  const imageStarted = new Promise<void>((resolve) => { imageStartedResolve = resolve; });
  notifyImageStarted = imageStartedResolve;
  await openHydratedSurface(page, "/workbench/image", "formal-image");
  await page.getByPlaceholder("描述想生成的图片…").fill("survives a browser reload");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await Promise.race([
    imageStarted,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mock image provider was not called")), 15_000)),
  ]);
  expect(imageProviderRequest?.authorization).toBe("Bearer sk-formal-private");
  expect(imageProviderRequest?.body).toMatchObject({
    model: "gpt-image-1", prompt: "survives a browser reload", n: 1, size: "1024x1024",
  });
  let durableCard = page.locator("article").filter({ hasText: "survives a browser reload" });
  await expect(durableCard.getByText("进行中", { exact: false })).toBeVisible();
  await page.reload();
  durableCard = page.locator("article").filter({ hasText: "survives a browser reload" });
  await expect(durableCard.getByText("进行中", { exact: false })).toBeVisible();
  releasePendingImageRequest();
  await expect(durableCard.getByText("成功", { exact: false })).toBeVisible({ timeout: 15_000 });
  const durableJobs = await request.get("/api/generation-jobs?projectId=&kind=image&page=1&pageSize=20");
  await expect(durableJobs).toBeOK();
  const durableJobPage = await durableJobs.json() as { items: Array<{ prompt: string; status: string; result: { items?: Array<{ storageKey?: string }> } }> };
  const durableJob = durableJobPage.items.find((item) => item.prompt === "survives a browser reload");
  expect(durableJob?.status).toBe("succeeded");
  const durableStorageKey = durableJob?.result.items?.[0]?.storageKey;
  expect(durableStorageKey).toBeTruthy();
  const durableBlob = await request.get(`/api/blobs/${encodeURIComponent(durableStorageKey!)}`);
  await expect(durableBlob).toBeOK();
  expect(Buffer.from(await durableBlob.body()).toString("base64")).toBe(generatedPNG);

  await page.goto("/");
  await expect(page.getByRole("toolbar", { name: "画布工具栏" })).toBeVisible();
  await page.getByTitle("设置").click();
  await expect(page.getByRole("button", { name: "拉取文本模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取生图模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取视频模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取音频模型" })).toBeVisible();
  const encryptionNotice = page.getByText(
    "API Key 与对象存储密钥经服务端加密后存入 PostgreSQL，数据库中不保存明文。",
    { exact: false },
  );
  await encryptionNotice.scrollIntoViewIfNeeded();
  await expect(encryptionNotice).toBeVisible();
  await page.getByRole("dialog", { name: "设置" }).getByRole("button", { name: "关闭设置" }).click();

  await page.getByRole("toolbar", { name: "画布工具栏" }).getByTitle("文本", { exact: true }).click();
  const editor = page.getByPlaceholder("写下提示词或说明…");
  await editor.fill("formal PostgreSQL persistence");

  await expect.poll(async () => {
    const projects = await request.get("/api/projects");
    const summaries = await projects.json() as Array<{ id: string }>;
    for (const project of summaries) {
      const response = await request.get(`/api/projects/${encodeURIComponent(project.id)}`);
      const document = await response.json() as { nodes?: Array<{ metadata?: { content?: string } }> };
      if (document.nodes?.some((node) => node.metadata?.content === "formal PostgreSQL persistence")) return true;
    }
    return false;
  }).toBe(true);

  const imageInput = page.getByRole("toolbar", { name: "画布工具栏" })
    .locator('input[type="file"][accept="image/*"]');
  await imageInput.setInputFiles({
    name: "formal-pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await page.getByRole("toolbar", { name: "画布工具栏" }).getByTitle("适应", { exact: true }).click();
  await expect(page.locator('[data-node-id] img').first()).toBeVisible();
  await expect.poll(async () => {
    const projects = await request.get("/api/projects");
    const summaries = await projects.json() as Array<{ id: string }>;
    for (const project of summaries) {
      const response = await request.get(`/api/projects/${encodeURIComponent(project.id)}`);
      const document = await response.json() as { nodes?: Array<{ type?: string; metadata?: { storageKey?: string } }> };
      if (document.nodes?.some((node) => node.type === "image" && node.metadata?.storageKey)) return true;
    }
    return false;
  }).toBe(true);

  await page.reload();
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue("formal PostgreSQL persistence");
  await expect(page.locator('img[alt="图片"]').first()).toBeVisible();

  await page.goto("/prompts");
  await page.getByRole("button", { name: "管理来源" }).click();
  let sourceManager = page.getByRole("dialog", { name: "管理提示词来源" });
  await sourceManager.getByLabel("来源名称").fill("Formal source");
  await sourceManager.getByLabel("来源解析格式").selectOption("json");
  await sourceManager.getByLabel("来源 URL").fill("https://formal-prompts.example/catalog.json");
  await sourceManager.getByLabel("条目路径").fill("payload.entries");
  await sourceManager.getByLabel("标题路径").fill("label");
  await sourceManager.getByLabel("正文路径").fill("value");
  await sourceManager.getByRole("button", { name: "保存来源" }).click();
  await sourceManager.getByRole("button", { name: "刷新" }).click();
  await sourceManager.getByTitle("关闭来源管理").click();
  await expect(page.getByText("Formal prompt", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Formal prompt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "管理来源" }).click();
  sourceManager = page.getByRole("dialog", { name: "管理提示词来源" });
  await expect(sourceManager.getByRole("listitem").filter({ hasText: "Formal source" })).toBeVisible();
  await sourceManager.getByTitle("关闭来源管理").click();

  await page.goto("/assets");
  await page.getByRole("button", { name: "新增文本" }).click();
  const creator = page.getByRole("dialog", { name: "新增素材" });
  await creator.getByLabel("标题").fill("Formal asset");
  await creator.getByLabel("内容").fill("Stored in PostgreSQL");
  await creator.getByRole("button", { name: "保存" }).click();
  await expect(creator).toHaveCount(0);
  await expect(page.locator("article").filter({ hasText: "Formal asset" })).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.locator("article").filter({ hasText: "Formal asset" })).toBeVisible();

  await page.goto("/");
  await page.getByRole("group", { name: "全局工具" })
    .getByRole("button", { name: "画布 Agent", exact: true })
    .click();
	await page.getByLabel("本地地址").fill("http://127.0.0.1:8793");
	await page.getByLabel("连接令牌").fill("e2e-token");
  const connectButton = page.getByRole("button", { name: "连接", exact: true });
  await expect(connectButton).toBeEnabled();
  await connectButton.click();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(page.getByText("board.list_nodes", { exact: true })).toBeVisible();

  const health = await request.get("/api/health");
  await expect(health).toBeOK();
  await expect(health.json()).resolves.toMatchObject({ storage: "postgresql+redis" });

  const generation = {
    id: "formal-job-1",
    projectId: "formal-project",
    kind: "image",
    status: "succeeded",
    prompt: "formal generation",
    providerId: "mock-provider",
    model: "mock-image",
    parameters: { size: "1024x1024" },
    result: { items: [] },
  };
  const created = await request.post("/api/generation-jobs", { data: generation });
  await expect(created).toBeOK();
  expect(created.status()).toBe(201);
  const createdJob = await created.json() as Record<string, unknown>;
  const listed = await request.get("/api/generation-jobs?projectId=formal-project&kind=image&page=1&pageSize=10");
  await expect(listed).toBeOK();
  await expect(listed.json()).resolves.toMatchObject({ page: 1, pageSize: 10, total: 1 });
  const restoredAt = "2026-07-01T02:03:04.567Z";
  const replaced = await request.put("/api/generation-jobs", { data: [
    createdJob,
    {
      ...generation,
      id: "formal-job-restored",
      prompt: "restored generation",
      createdAt: restoredAt,
      updatedAt: restoredAt,
    },
  ] });
  expect(replaced.status()).toBe(204);
  const restored = await request.get("/api/generation-jobs/formal-job-restored");
  await expect(restored).toBeOK();
  await expect(restored.json()).resolves.toMatchObject({
    id: "formal-job-restored",
    createdAt: restoredAt,
    updatedAt: restoredAt,
  });
  const ownerClientId = await page.evaluate(() => sessionStorage.getItem("openboard:runtime-owner-id"));
  expect(ownerClientId).toMatch(/^owner-[A-Za-z0-9]+$/);
  const orphaned = await request.post("/api/generation-jobs", { data: {
    ...generation,
    id: "formal-job-orphaned",
    status: "running",
    prompt: "interrupted by reload",
    parameters: { ownerClientId },
  } });
  await expect(orphaned).toBeOK();
  await page.reload();
	await expect(page.getByRole("toolbar", { name: "画布工具栏" })).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get("/api/generation-jobs/formal-job-orphaned");
    return await response.json() as { status?: string; error?: string };
  }).toMatchObject({ status: "failed", error: "页面刷新后任务已中断，请重试" });
  const cleared = await request.put("/api/generation-jobs", { data: [] });
  expect(cleared.status()).toBe(204);
});

test("formal workflow survives reload, checkpoints steps, and exposes image children", async ({ page, request }) => {
  const provider = { baseUrl: imageUpstreamURL, apiKey: "", model: "gpt-image-1", protocol: "openai" };
  const config = {
    channels: [{
      id: "formal-image", name: "Formal image", baseUrl: imageUpstreamURL, apiKey: "",
      defaultTextModel: "gpt-4o-mini", defaultImageModel: "gpt-image-1",
      defaultVideoModel: "sora-2", defaultAudioModel: "gpt-4o-mini-tts",
      providers: {
        text: { ...provider, model: "gpt-4o-mini" }, image: provider,
        video: { ...provider, model: "sora-2" }, audio: { ...provider, model: "gpt-4o-mini-tts" },
      },
    }],
    activeChannelId: "formal-image", systemPrompt: "", imageSize: "1024x1024",
    imageQuality: "auto", imageCount: 1, theme: "light",
  };
  await saveFormalConfig(request, config, {
    "formal-image": { image: "sk-formal-private" },
  });

  const timestamp = "2026-07-24T00:00:00.000Z";
  const template = {
    schemaVersion: 1, id: "formal_series", revision: 1, scope: "personal",
    title: "Formal durable workflow", description: "Two durable steps", category: "E2E",
    variables: [{ id: "subject", kind: "textarea", label: "Subject", required: true }],
    steps: [
      {
        id: "base", title: "Base", promptTemplate: "{{subject}} base", providerId: "formal-image",
        parameters: { size: "1024x1024", count: 1 }, references: [],
      },
      {
        id: "scene", title: "Scene", promptTemplate: "{{subject}} scene", providerId: "formal-image",
        parameters: { size: "1024x1024", count: 1 },
        references: [{ source: "step", stepId: "base", output: 0 }],
      },
    ],
    createdAt: timestamp, updatedAt: timestamp,
  };
  const savedTemplate = await request.put("/api/workflow-templates/formal_series", { data: template });
  await expect(savedTemplate).toBeOK();
  const templates = await request.get("/api/workflow-templates");
  await expect(templates).toBeOK();
  await expect(templates.json()).resolves.toMatchObject([{ id: "formal_series", scope: "personal" }]);

  const projectsResponse = await request.get("/api/projects");
  const projects = await projectsResponse.json() as Array<{ id: string }>;
  expect(projects[0]?.id).toBeTruthy();
  const projectId = projects[0]!.id;

  let firstStartedResolve: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
  notifyImageStarted = firstStartedResolve;
  const created = await request.post("/api/generation-jobs/workflow", { data: {
    id: "formal_workflow_run", projectId,
    templateSnapshot: template, values: { subject: "durable tiger" },
  } });
  expect(created.status()).toBe(202);
  await Promise.race([
    firstStarted,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first workflow step did not start")), 15_000)),
  ]);

  await page.goto("/workbench/workflows");
  let card = page.locator("article").filter({ hasText: "Formal durable workflow" });
  await expect(card.getByText("运行中", { exact: false })).toBeVisible();
  await page.reload();
  card = page.locator("article").filter({ hasText: "Formal durable workflow" });
  await expect(card.getByText("运行中", { exact: false })).toBeVisible();

  let secondStartedResolve: (() => void) | undefined;
  const secondStarted = new Promise<void>((resolve) => { secondStartedResolve = resolve; });
  notifyImageStarted = secondStartedResolve;
  releasePendingImageRequest();
  await Promise.race([
    secondStarted,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("second workflow step did not start")), 15_000)),
  ]);
  releasePendingImageRequest();

  await expect(card.getByText("已完成", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole("img", { name: "工作流生成结果" })).toHaveCount(2);
  const parentResponse = await request.get("/api/generation-jobs/formal_workflow_run");
  await expect(parentResponse).toBeOK();
  const parent = await parentResponse.json() as {
    status: string;
    result: { outputStorageKeys: string[]; steps: Record<string, { status: string; storageKeys?: string[] }> };
  };
  expect(parent).toMatchObject({
    status: "succeeded",
    result: { steps: { base: { status: "succeeded" }, scene: { status: "succeeded" } } },
  });
  expect(parent.result.outputStorageKeys).toEqual(parent.result.steps.scene.storageKeys);
  const childResponse = await request.get(`/api/generation-jobs?projectId=${encodeURIComponent(projectId)}&kind=image&page=1&pageSize=20`);
  const children = await childResponse.json() as { items: Array<{ parameters: { workflowRunId?: string }; status: string }> };
  expect(children.items.filter((job) => job.parameters.workflowRunId === "formal_workflow_run"))
    .toHaveLength(2);
  const finalBlob = await request.get(`/api/blobs/${encodeURIComponent(parent.result.outputStorageKeys[0]!)}`);
  await expect(finalBlob).toBeOK();
});
