import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMigrationPreflight, createWorkspaceManifest } from "@/services/local-workspace-migration";
import { LoginMigrationDialog, formatMigrationBytes } from "./LoginMigrationDialog";

describe("login workspace migration dialog", () => {
  test("shows local counts, bytes, resumable progress, and explicit choices", () => {
    const local = createWorkspaceManifest([
      { kind: "project", id: "project:a", fingerprint: "a", bytes: 1024 },
      { kind: "blob", id: "image:a", fingerprint: "image", bytes: 2048 },
    ]);
    const preflight = createMigrationPreflight(local, createWorkspaceManifest([]));
    const html = renderToStaticMarkup(
      <LoginMigrationDialog
        preflight={preflight}
        phase="migrating"
        completedOperations={1}
        availableBytes={4096}
        error={null}
        onMigrate={() => undefined}
        onCancel={() => undefined}
        onKeepLocal={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(html).toContain("发现本地工作区数据");
    expect(html).toContain("1 个画布");
    expect(html).toContain("2 个资源");
    expect(html).toContain("3 KB");
    expect(html).toContain("4 KB 可用");
    expect(html).toContain("1 / 2");
    expect(html).toContain("迁移到当前账号");
    expect(html).toContain("取消迁移");
  });

  test("surfaces conflicts and disables migration instead of overwriting", () => {
    const local = createWorkspaceManifest([
      { kind: "state", id: "assets", fingerprint: "local", bytes: 100 },
    ]);
    const remote = createWorkspaceManifest([
      { kind: "state", id: "assets", fingerprint: "remote", bytes: 100 },
    ]);
    const html = renderToStaticMarkup(
      <LoginMigrationDialog
        preflight={createMigrationPreflight(local, remote)}
        phase="idle"
        completedOperations={0}
        availableBytes={null}
        error={null}
        onMigrate={() => undefined}
        onCancel={() => undefined}
        onKeepLocal={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(html).toContain("1 项冲突");
    expect(html).toContain("disabled");
    expect(html).toContain("不会覆盖账号中的现有数据");
    expect(html).toContain("容量不可用");
  });

  test("renders an active cancel action while migration is running", () => {
    const preflight = createMigrationPreflight(
      createWorkspaceManifest([{ kind: "blob", id: "image:a", fingerprint: "a", bytes: 1 }]),
      createWorkspaceManifest([]),
    );
    let cancelled = 0;
    const element = LoginMigrationDialog({
      preflight,
      phase: "migrating",
      completedOperations: 0,
      availableBytes: null,
      error: null,
      onMigrate: () => undefined,
      onCancel: () => { cancelled += 1; },
      onKeepLocal: () => undefined,
      onContinue: () => undefined,
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("取消迁移");
    const buttons: Array<{ props: { children?: unknown; onClick?: () => void; disabled?: boolean } }> = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const item = node as { type?: unknown; props?: { children?: unknown; onClick?: () => void; disabled?: boolean } };
      if (item.type === "button" && item.props) buttons.push({ props: item.props });
      const children = item.props?.children;
      for (const child of Array.isArray(children) ? children : [children]) visit(child);
    };
    visit(element);
    const cancel = buttons.find(({ props }) => props.children === "取消迁移");
    expect(cancel?.props.disabled).not.toBe(true);
    cancel?.props.onClick?.();
    expect(cancelled).toBe(1);
  });

  test("formats bounded byte totals for people", () => {
    expect(formatMigrationBytes(0)).toBe("0 B");
    expect(formatMigrationBytes(1536)).toBe("1.5 KB");
    expect(formatMigrationBytes(2 * 1024 * 1024)).toBe("2 MB");
  });

  test("blocks migration when known account capacity is insufficient", () => {
    const preflight = createMigrationPreflight(
      createWorkspaceManifest([{ kind: "blob", id: "image:a", fingerprint: "a", bytes: 2048 }]),
      createWorkspaceManifest([]),
    );
    const html = renderToStaticMarkup(
      <LoginMigrationDialog
        preflight={preflight}
        phase="idle"
        completedOperations={0}
        availableBytes={1024}
        error={null}
        onMigrate={() => undefined}
        onCancel={() => undefined}
        onKeepLocal={() => undefined}
        onContinue={() => undefined}
      />,
    );
    expect(html).toContain("空间不足");
    expect(html).toContain("disabled");
  });

  test("lists credential categories and requires an explicit opt-in", () => {
    const preflight = createMigrationPreflight(
      createWorkspaceManifest([{ kind: "state", id: "config", fingerprint: "a", bytes: 1 }]),
      createWorkspaceManifest([]),
    );
    const html = renderToStaticMarkup(
      <LoginMigrationDialog
        preflight={preflight}
        phase="idle"
        completedOperations={0}
        availableBytes={1024}
        error={null}
        credentials={{ present: true, labels: ["2 个 AI 渠道 API 密钥", "WebDAV 密码"] }}
        includeSecrets={false}
        onIncludeSecretsChange={() => undefined}
        onMigrate={() => undefined}
        onCancel={() => undefined}
        onKeepLocal={() => undefined}
        onContinue={() => undefined}
      />,
    );
    expect(html).toContain("默认不迁移");
    expect(html).toContain("2 个 AI 渠道 API 密钥");
    expect(html).toContain("WebDAV 密码");
    expect(html).toContain("明确同意");
    expect(html).not.toContain("checked");
  });
});
