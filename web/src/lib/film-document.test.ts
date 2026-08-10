import { describe, expect, test } from "bun:test";

import { createNode, createProject } from "@/lib/defaults";
import {
  applyApprovedFilmRepair,
  buildFilmProjectionDiffs,
  commitFilmProjection,
  createFilmDocument,
  decomposeFilmSource,
  ensureFilmSceneDirectorNode,
  refreshFilmProjection,
  validateFilmDocument,
} from "@/lib/film-document";

describe("film document", () => {
  test("decomposes a manuscript deterministically into episodes, scenes, and draft shots", () => {
    const film = createFilmDocument("project_film");
    const next = decomposeFilmSource(film, [
      "EPISODE 1 — Arrival",
      "INT. OBSERVATORY - NIGHT",
      "Mira opens the brass dome. The telescope turns toward a green comet.",
      "",
      "EXT. HILL ROAD - DAWN",
      "A courier cycles through rain and stops at the locked gate.",
    ].join("\n"));

    expect(next.episodes).toHaveLength(1);
    expect(next.scenes.map((scene) => scene.heading)).toEqual([
      "INT. OBSERVATORY - NIGHT",
      "EXT. HILL ROAD - DAWN",
    ]);
    expect(next.shots.length).toBeGreaterThanOrEqual(2);
    expect(next.shots.every((shot) => shot.status === "draft" && shot.revision === 1)).toBe(true);
    expect(decomposeFilmSource(film, next.source.text)).toEqual(next);
  });

  test("enforces decomposition counters before appending more entities", () => {
    const film = createFilmDocument("project_limits");
    expect(() => decomposeFilmSource(
      film,
      "EPISODE 1\nOne.\nEPISODE 2\nTwo.",
      { episodes: 1, scenes: 10, shots: 10, entities: 20 },
    )).toThrow("episode limit");
    expect(() => decomposeFilmSource(
      film,
      "INT. ONE - DAY\nOne.\nINT. TWO - DAY\nTwo.",
      { episodes: 10, scenes: 1, shots: 10, entities: 20 },
    )).toThrow("scene limit");
    expect(() => decomposeFilmSource(
      film,
      "INT. ONE - DAY\nOne. Two.",
      { episodes: 10, scenes: 10, shots: 1, entities: 20 },
    )).toThrow("shot limit");
  });

  test("quality validation proposes repairs without mutating production entities", () => {
    const decomposed = decomposeFilmSource(
      createFilmDocument("project_quality"),
      "INT. EDIT SUITE - DAY\nA blank monitor flickers.",
    );
    const before = structuredClone(decomposed);
    const report = validateFilmDocument(decomposed);

    expect(report.issues.some((issue) => issue.code === "missing_media")).toBe(true);
    expect(report.repairs.every((repair) => repair.approved === false)).toBe(true);
    expect(decomposed).toEqual(before);
  });

  test("applies only user-approved repairs with an exact entity revision", () => {
    const film = decomposeFilmSource(
      createFilmDocument("project_repair"),
      "INT. SOUNDSTAGE - DAY\nAn actor crosses the empty set.",
    );
    const report = validateFilmDocument(film);
    const repair = report.repairs.find((candidate) => candidate.targetType === "shot")!;
    const pending = { ...film, qualityReports: [report] };

    expect(() => applyApprovedFilmRepair(pending, repair.id)).toThrow("approved");
    const approved = {
      ...pending,
      qualityReports: [{
        ...report,
        repairs: report.repairs.map((candidate) =>
          candidate.id === repair.id ? { ...candidate, approved: true } : candidate),
      }],
    };
    const repaired = applyApprovedFilmRepair(approved, repair.id);
    const target = repaired.shots.find((shot) => shot.id === repair.targetId)!;

    expect(target.revision).toBe(repair.expectedRevision + 1);
    expect(approved.shots.find((shot) => shot.id === repair.targetId)?.revision).toBe(repair.expectedRevision);
    expect(() => applyApprovedFilmRepair(repaired, repair.id)).toThrow("revision");
  });

  test("refreshes only managed projections and preserves user nodes and layout", () => {
    const board = createProject("Projected film", "film");
    board.nodes = [{
      id: "user_note",
      type: "text",
      title: "My note",
      position: { x: 17, y: 29 },
      width: 280,
      height: 180,
      metadata: { content: "Do not touch" },
    }];
    const film = decomposeFilmSource(
      createFilmDocument(board.id),
      "INT. ARCHIVE - NIGHT\nA paper map unfolds beneath a lamp.",
    );
    const first = refreshFilmProjection(board, film);
    const projected = first.nodes.find((node) => node.metadata.filmProjectionKey)!;
    const moved = {
      ...first,
      nodes: first.nodes.map((node) => node.id === projected.id
        ? { ...node, position: { x: 911, y: 377 } }
        : node),
    };
    const second = refreshFilmProjection(moved, film);

    expect(second.nodes.find((node) => node.id === "user_note")).toEqual(board.nodes[0]);
    expect(second.nodes.find((node) => node.id === projected.id)?.position).toEqual({ x: 911, y: 377 });
    expect(second.nodes.find((node) => node.id === projected.id)?.metadata.filmProjectionKey)
      .toBe(projected.metadata.filmProjectionKey);
  });

  test("commits only whitelisted projection fields with compare-and-swap revision", () => {
    const board = createProject("Projection commit", "film");
    const film = decomposeFilmSource(
      createFilmDocument(board.id),
      "EXT. RIVER LANDING - DUSK\nA ferry reaches the pier.",
    );
    const projected = refreshFilmProjection(board, film).nodes.find((node) =>
      node.metadata.filmProjectionKey?.startsWith("shot:"),
    )!;
    const committed = commitFilmProjection(film, {
      projectionKey: projected.metadata.filmProjectionKey!,
      expectedRevision: projected.metadata.filmProjectionRevision!,
      fields: { title: "Wide ferry arrival", content: "Hold on the wake for two beats." },
    });

    expect(committed.shots[0]?.title).toBe("Wide ferry arrival");
    expect(committed.shots[0]?.description).toBe("Hold on the wake for two beats.");
    expect(() => commitFilmProjection(committed, {
      projectionKey: projected.metadata.filmProjectionKey!,
      expectedRevision: projected.metadata.filmProjectionRevision!,
      fields: { title: "Stale write" },
    })).toThrow("revision");
  });

  test("builds canvas projection differences and ignores unchanged managed nodes", () => {
    const document = decomposeFilmSource(createFilmDocument("film-diff", "2026-08-09T00:00:00.000Z"), "INT. ROOM - DAY\nA door opens.");
    const project = refreshFilmProjection({ ...createProject("Film", "film"), id: "film-diff" }, document);
    const managed = project.nodes.find((node) => node.metadata.filmProjectionKey?.startsWith("shot:"))!;
    const changed = {
      ...project,
      nodes: project.nodes.map((node) => node.id === managed.id
        ? { ...node, title: "Close shot", metadata: { ...node.metadata, content: "The door opens slowly." } }
        : node),
    };
    expect(buildFilmProjectionDiffs(project, document)).toEqual([]);
    expect(buildFilmProjectionDiffs(changed, document)).toEqual([{
      projectionKey: managed.metadata.filmProjectionKey,
      expectedRevision: managed.metadata.filmProjectionRevision,
      before: { title: managed.title, content: managed.metadata.content },
      after: { title: "Close shot", content: "The door opens slowly." },
    }]);
  });

  test("creates or locates one managed Director node without changing user nodes or layout", () => {
    const document = decomposeFilmSource(createFilmDocument("film-director", "2026-08-09T00:00:00.000Z"), "INT. ROOM - DAY\nA door opens.");
    const scene = document.scenes[0]!;
    const board = { ...createProject("Film", "film"), id: document.projectId };
    const userDirector = createNode("director", { x: 40, y: 50 }, { id: "user-director", title: "User setup" });
    const first = ensureFilmSceneDirectorNode({ ...board, nodes: [userDirector] }, scene);
    const managed = first.project.nodes.find((node) => node.id === first.nodeId)!;

    expect(first.created).toBe(true);
    expect(first.project.nodes.find((node) => node.id === userDirector.id)).toEqual(userDirector);
    expect(managed).toMatchObject({
      type: "director",
      title: `Director · ${scene.heading}`,
      metadata: { filmProjectionKey: `director:${scene.id}`, filmProjectionRevision: scene.revision },
    });
    expect(managed.metadata.directorScene).toBeDefined();

    const moved = { ...first.project, nodes: first.project.nodes.map((node) => node.id === managed.id ? { ...node, position: { x: 811, y: 377 }, title: "Custom working title" } : node) };
    const second = ensureFilmSceneDirectorNode(moved, { ...scene, heading: "INT. UPDATED", revision: scene.revision + 1 });

    expect(second.created).toBe(false);
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.project.nodes).toHaveLength(2);
    expect(second.project.nodes.find((node) => node.id === managed.id)).toMatchObject({
      position: { x: 811, y: 377 },
      title: "Custom working title",
      metadata: { filmProjectionKey: `director:${scene.id}`, filmProjectionRevision: scene.revision + 1 },
    });
  });
});
