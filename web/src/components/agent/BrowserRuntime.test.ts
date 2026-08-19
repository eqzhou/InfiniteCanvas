import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AgentConnection } from "@/services/local-agent";
import { clearGenerationActivities } from "@/services/generation-activity";
import { getRuntimeOwnerId } from "@/services/runtime-identity";
import type { GenerationJob } from "@/types/board";
import type { RuntimeCommand } from "@/services/runtime-client";
import {
  executeRuntimeCommand,
  recoverInterruptedGenerationJobs,
} from "./BrowserRuntime";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGenerationActivities();
  mock.restore();
});

function job(status: GenerationJob["status"], updatedAt: string, ownerClientId = getRuntimeOwnerId()): GenerationJob {
  return {
    id: "runtime-recovery-race",
    kind: "image",
    status,
    prompt: "runtime recovery",
    parameters: { ownerClientId },
    result: status === "succeeded" ? { items: [{ storageKey: "image:runtime" }] } : {},
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
  };
}

const connection = { baseUrl: "http://127.0.0.1:8790", token: "" } as AgentConnection;
const translate = ((key: string) => key) as Parameters<typeof executeRuntimeCommand>[3];

describe("browser runtime generation recovery", () => {
  test("generation status does not overwrite a terminal job after a CAS conflict", async () => {
    const running = job("running", "2026-08-01T00:00:01.000Z");
    const completed = job("succeeded", "2026-08-01T00:00:02.000Z");
    let reads = 0;
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/runtime-recovery-race/recover")) return new Response("changed", { status: 409 });
      if (url.endsWith("/runtime-recovery-race")) {
        reads += 1;
        return new Response(JSON.stringify(reads === 1 ? running : completed), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const command: RuntimeCommand = {
      id: "runtime-command",
      method: "generation_get_status",
      data: { taskId: running.id },
    };
    const result = await executeRuntimeCommand(command, connection, () => undefined, translate);

    expect(result).toMatchObject({ task: completed });
    expect(requests).toEqual([
      "GET /api/generation-jobs/runtime-recovery-race",
      "POST /api/generation-jobs/runtime-recovery-race/recover",
      "GET /api/generation-jobs/runtime-recovery-race",
    ]);
  });

  test("periodic recovery returns the newer terminal job after a CAS conflict", async () => {
    const running = job("running", "2026-08-01T00:00:01.000Z");
    const completed = job("succeeded", "2026-08-01T00:00:02.000Z");
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/runtime-recovery-race/recover")) return new Response("changed", { status: 409 });
      if (url.endsWith("/runtime-recovery-race")) {
        return new Response(JSON.stringify(completed), { headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(recoverInterruptedGenerationJobs([running], getRuntimeOwnerId(), new Set(), "interrupted"))
      .resolves.toEqual([completed]);
  });
});
