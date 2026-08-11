import { authFetch } from "@/services/auth-session";

export type FilmAgentReadTool = "film.status" | "film.check" | "film.proposals" | "film.next_steps";
const readTools = new Set<FilmAgentReadTool>(["film.status", "film.check", "film.proposals", "film.next_steps"]);
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function executeFilmAgentRead(tool: FilmAgentReadTool, projectId: string): Promise<unknown> {
  if (!readTools.has(tool)) throw new Error("Film Agent 只读入口不允许高影响操作");
  if (!projectPattern.test(projectId)) throw new Error("影视项目 ID 无效");
  return execute(tool, projectId);
}

async function execute(tool: FilmAgentReadTool, projectId: string): Promise<unknown> {
  const response = await authFetch("agent/execute", { method: "POST", body: JSON.stringify({ tool, arguments: { projectId } }) });
  const payload = await response.json().catch(() => null) as { ok?: unknown; data?: unknown; error?: { message?: unknown } } | null;
  if (!response.ok || payload?.ok !== true) {
    const message = typeof payload?.error?.message === "string" ? payload.error.message : `Film Agent 请求失败：HTTP ${response.status}`;
    throw new Error(message.slice(0, 500));
  }
  return payload.data;
}
