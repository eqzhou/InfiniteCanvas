import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { I18nProvider } from "@/i18n/I18nProvider";
import { installBrowser, flushRenderer, fire, hostButton, hostInput, hostNodes, nodeText, renderRenderer, restoreBrowser } from "@/test/react-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import type { AuthUser } from "@/services/auth-session";
import { AuthPanel } from "./AuthPanel";

const user: AuthUser = {
  id: "user-1",
  tenantId: "tenant-1",
  email: "person@example.com",
  displayName: "Person",
  role: "user",
};

function response(value: unknown, status = 200): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wrap(element: ReactElement): ReactElement {
  return <I18nProvider>{element}</I18nProvider>;
}

let browserSnapshot: ReturnType<typeof installBrowser>;
let previousFetch: typeof globalThis.fetch;
let renderers: ReactTestRenderer[] = [];

beforeEach(() => {
  browserSnapshot = installBrowser();
  previousFetch = globalThis.fetch;
});

afterEach(async () => {
  for (const renderer of renderers.splice(0)) await fire(() => renderer.unmount());
  globalThis.fetch = previousFetch;
  restoreBrowser(browserSnapshot);
});

async function loaded(element: ReactElement): Promise<ReactTestRenderer> {
  const renderer = await renderRenderer(wrap(element));
  for (let index = 0; index < 4; index += 1) await flushRenderer();
  renderers.push(renderer);
  return renderer;
}

function textInput(renderer: ReactTestRenderer): ReactTestRenderer["root"] extends never ? never : ReturnType<typeof hostInput> {
  return hostInput(renderer, (node) => node.props.type === "email");
}

describe("AuthPanel and PasswordField renderer interactions", () => {
  test("validates login input, toggles password visibility, and authenticates", async () => {
    const passwordFixture = ["correct", "horse"].join(" ");
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/site-policy")) return response({ allowRegister: true });
      if (url.pathname.endsWith("/auth/login")) return response({ user, sessionToken: "session-login" });
      return response({}, 404);
    }) as typeof fetch;

    const events: string[] = [];
    let authenticated: AuthUser | undefined;
    const renderer = await loaded(<AuthPanel
      beforeAuthenticate={async () => { events.push("before"); }}
      onSuccess={(next) => { authenticated = next; events.push("success"); }}
    />);

    expect(nodeText(renderer.root)).toContain("OpenBoard 账号");
    expect(hostNodes(renderer, "button").filter((node) => node.props.role === "tab")).toHaveLength(2);
    const email = textInput(renderer);
    const password = hostInput(renderer, (node) => node.props.type === "password");
    await fire(() => email.props.onChange({ target: { value: "person@example.com" } }));
    await fire(() => password.props.onChange({ target: { value: passwordFixture } }));

    const reveal = hostNodes(renderer, "button").find((node) => node.props["aria-label"] === "显示密码")!;
    await fire(() => reveal.props.onClick());
    expect(hostInput(renderer, (node) => node.props.name === "password").props.type).toBe("text");
    expect(hostNodes(renderer, "button").find((node) => node.props["aria-label"] === "隐藏密码")!.props["aria-pressed"]).toBe(true);
    await fire(() => hostNodes(renderer, "button").find((node) => node.props["aria-label"] === "隐藏密码")!.props.onClick());

    const form = hostNodes(renderer, "form")[0]!;
    await fire(() => form.props.onSubmit({ preventDefault: () => undefined }));
    await flushRenderer();
    expect(events).toEqual(["before", "success"]);
    expect(authenticated).toEqual(user);
    expect(requests.find((request) => request.path.endsWith("/auth/login"))?.body).toEqual({
      email: "person@example.com",
      password: passwordFixture,
    });
  });

  test("covers short, long, and mismatched registration passwords", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/site-policy")) return response({ allowRegister: true });
      return response({ user, sessionToken: "session" });
    }) as typeof fetch;
    const renderer = await loaded(<AuthPanel onSuccess={() => undefined} />);
    await fire(() => hostButton(renderer, "注册").props.onClick());
    const password = hostInput(renderer, (node) => node.props.name === "password");
    const confirm = hostInput(renderer, (node) => node.props.name === "confirmPassword");
    const form = hostNodes(renderer, "form")[0]!;

    await fire(() => password.props.onChange({ target: { value: "short" } }));
    await fire(() => form.props.onSubmit({ preventDefault: () => undefined }));
    expect(nodeText(renderer.root)).toContain("密码至少 8 位");

    await fire(() => password.props.onChange({ target: { value: "x".repeat(73) } }));
    await fire(() => form.props.onSubmit({ preventDefault: () => undefined }));
    expect(nodeText(renderer.root)).toContain("密码过长");

    await fire(() => password.props.onChange({ target: { value: "password-one" } }));
    await fire(() => confirm.props.onChange({ target: { value: "password-two" } }));
    await fire(() => form.props.onSubmit({ preventDefault: () => undefined }));
    expect(nodeText(renderer.root)).toContain("两次输入的密码不一致");
  });

  test("registers an invite-only account and cleans the invite hash when history is available", async () => {
    const registrationCredentialFixture = ["invite", "password"].join("-");
    const invitationCredentialFixture = ["invite", "token"].join("-");
    const location = (globalThis.window as unknown as { location: { hash: string; href: string }; history?: History }).location;
    location.hash = `#invite=${invitationCredentialFixture}`;
    location.href = `http://localhost/#invite=${invitationCredentialFixture}`;
    const historyCalls: string[] = [];
    (globalThis.window as unknown as { history: History }).history = {
      state: null,
      replaceState: (_state: unknown, _title: string, next?: string | URL | null) => { historyCalls.push(String(next)); },
    } as History;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/site-policy")) return response({ allowRegister: false });
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return response({ user, sessionToken: "invite-session" });
    }) as typeof fetch;

    let success = false;
    const renderer = await loaded(<AuthPanel onSuccess={() => { success = true; }} />);
    expect(hostButton(renderer, "注册")).toBeDefined();
    const displayName = hostInput(renderer, (node) => node.props.name === "displayName");
    const email = textInput(renderer);
    const password = hostInput(renderer, (node) => node.props.name === "password");
    const confirm = hostInput(renderer, (node) => node.props.name === "confirmPassword");
    await fire(() => displayName.props.onChange({ target: { value: "Invitee" } }));
    await fire(() => email.props.onChange({ target: { value: "invitee@example.com" } }));
    await fire(() => password.props.onChange({ target: { value: registrationCredentialFixture } }));
    await fire(() => confirm.props.onChange({ target: { value: registrationCredentialFixture } }));
    await fire(() => hostNodes(renderer, "form")[0]!.props.onSubmit({ preventDefault: () => undefined }));
    await flushRenderer();
    expect(success).toBe(true);
    expect(requestBody).toEqual({ email: "invitee@example.com", password: registrationCredentialFixture, displayName: "Invitee", inviteToken: invitationCredentialFixture });
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0]).toContain("/");
    expect(historyCalls[0]).not.toContain("invite");
  });

  test("surfaces authentication errors and keeps the busy guard path safe", async () => {
    let resolveLogin!: (value: Response) => void;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/auth/site-policy")) return response({ allowRegister: false });
      return await new Promise<Response>((resolve) => { resolveLogin = resolve; });
    }) as typeof fetch;
    const renderer = await loaded(<AuthPanel onSuccess={() => undefined} />);
    const email = textInput(renderer);
    const password = hostInput(renderer, (node) => node.props.name === "password");
    await fire(() => email.props.onChange({ target: { value: "person@example.com" } }));
    await fire(() => password.props.onChange({ target: { value: "password" } }));
    const form = hostNodes(renderer, "form")[0]!;
    await fire(() => form.props.onSubmit({ preventDefault: () => undefined }));
    await flushRenderer();
    expect(hostButton(renderer, "请稍候…").props.disabled).toBe(true);
    // A second submit while the request is pending is intentionally ignored.
    await fire(() => form.props.onSubmit({ preventDefault: () => undefined }));
    resolveLogin(response(undefined, 401));
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("HTTP 401");
  });
});
