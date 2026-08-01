import { describe, expect, test } from "bun:test";

import {
  bindDirectorPanorama,
  isSphericalDirectorEnvironment,
  isUsableDirectorEnvironment,
  listDirectorEnvironmentOptions,
  removeEdgeAndReconcilePanorama,
  resolveDirectorPanorama,
} from "./director-panorama";
import { createNode, createProject } from "./defaults";

describe("director panorama graph binding", () => {
  test("allows an empty panorama node to be connected before media is uploaded", () => {
    const project = createProject("Panorama shot");
    const panorama = createNode("panorama", { x: 0, y: 0 });
    const director = createNode("director", { x: 500, y: 0 });
    const source = { ...project, nodes: [panorama, director] };

    const bound = bindDirectorPanorama(source, director.id, panorama.id);

    expect(bound.edges).toHaveLength(1);
    expect(bound.edges[0]).toMatchObject({ from: panorama.id, to: director.id });
    expect(resolveDirectorPanorama(bound, director.id)).toBeUndefined();
  });

  test("binds a panorama to a director atomically and immutably", () => {
    const project = createProject("Panorama shot");
    const panorama = createNode("panorama", { x: 0, y: 0 }, { metadata: {
      content: "blob:panorama",
      storageKey: "image:panorama",
      naturalWidth: 2048,
      naturalHeight: 1024,
      panoramaProjection: "equirectangular",
    } });
    const director = createNode("director", { x: 500, y: 0 });
    const source = { ...project, nodes: [panorama, director] };
    const next = bindDirectorPanorama(source, director.id, panorama.id);

    expect(next).not.toBe(source);
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0]).toMatchObject({ from: panorama.id, to: director.id });
    expect(resolveDirectorPanorama(next, director.id)?.id).toBe(panorama.id);
    expect(resolveDirectorPanorama(source, director.id)).toBeUndefined();
  });


  test("allows an empty image node to be connected before media is uploaded", () => {
    const project = createProject("Image environment");
    const image = createNode("image", { x: 0, y: 0 });
    const director = createNode("director", { x: 500, y: 0 });
    const source = { ...project, nodes: [image, director] };
    const bound = bindDirectorPanorama(source, director.id, image.id);
    expect(bound.edges).toHaveLength(1);
    expect(bound.edges[0]).toMatchObject({ from: image.id, to: director.id });
    expect(resolveDirectorPanorama(bound, director.id)).toBeUndefined();
  });

  test("binds a connected ordinary image node as a selectable director environment", () => {
    const project = createProject("Image environment");
    const image = createNode("image", { x: 0, y: 0 }, { metadata: {
      content: "blob:image",
      storageKey: "image:ordinary",
      naturalWidth: 1920,
      naturalHeight: 1080,
      status: "success",
    } });
    const director = createNode("director", { x: 500, y: 0 });
    const source = { ...project, nodes: [image, director] };

    const bound = bindDirectorPanorama(source, director.id, image.id);

    expect(bound.edges).toHaveLength(1);
    expect(bound.edges[0]).toMatchObject({ from: image.id, to: director.id });
    expect(isUsableDirectorEnvironment(image)).toBe(true);
    expect(resolveDirectorPanorama(bound, director.id)?.id).toBe(image.id);
    expect(listDirectorEnvironmentOptions(bound, director.id).map((node) => node.id)).toEqual([image.id]);
  });

  test("keeps multiple environment edges and prefers the active selection", () => {
    const project = createProject("Environment choice");
    const image = createNode("image", { x: 0, y: 0 }, { metadata: {
      content: "blob:image",
      storageKey: "image:ordinary",
      naturalWidth: 1280,
      naturalHeight: 720,
    } });
    const panorama = createNode("panorama", { x: 0, y: 300 }, { metadata: {
      content: "blob:panorama",
      storageKey: "image:panorama",
      naturalWidth: 2048,
      naturalHeight: 1024,
      panoramaProjection: "equirectangular",
    } });
    const director = createNode("director", { x: 500, y: 0 });
    const source = { ...project, nodes: [image, panorama, director] };
    const withImage = bindDirectorPanorama(source, director.id, image.id);
    expect(resolveDirectorPanorama(withImage, director.id)?.id).toBe(image.id);
    expect(isSphericalDirectorEnvironment(image)).toBe(false);
    expect(isSphericalDirectorEnvironment(panorama)).toBe(true);

    const withPanorama = bindDirectorPanorama(withImage, director.id, panorama.id);
    expect(withPanorama.edges.filter((edge) => edge.to === director.id)).toHaveLength(2);
    expect(resolveDirectorPanorama(withPanorama, director.id)?.id).toBe(panorama.id);
    expect(listDirectorEnvironmentOptions(withPanorama, director.id).map((node) => node.id).sort())
      .toEqual([image.id, panorama.id].sort());
    expect(listDirectorEnvironmentOptions(withImage, director.id).map((node) => node.id))
      .toEqual([image.id]);
  });

  test("prefers a strict panorama over an ordinary image only for automatic fallback", () => {
    const project = createProject("Environment fallback");
    const image = createNode("image", { x: 0, y: 0 }, { metadata: {
      content: "blob:image",
      storageKey: "image:ordinary",
      naturalWidth: 1024,
      naturalHeight: 1536,
    } });
    const panorama = createNode("panorama", { x: 0, y: 300 }, { metadata: {
      content: "blob:panorama",
      storageKey: "image:panorama",
      naturalWidth: 2048,
      naturalHeight: 1024,
      panoramaProjection: "equirectangular",
    } });
    const director = createNode("director", { x: 500, y: 0 });
    const connected = {
      ...project,
      nodes: [image, panorama, director],
      edges: [
        { id: "edge_image", from: image.id, to: director.id },
        { id: "edge_panorama", from: panorama.id, to: director.id },
      ],
    };

    expect(resolveDirectorPanorama(connected, director.id)?.id).toBe(panorama.id);
    expect(resolveDirectorPanorama(bindDirectorPanorama(connected, director.id, image.id), director.id)?.id)
      .toBe(image.id);
  });

  test("prefers a strict equirectangular image node during automatic fallback", () => {
    const project = createProject("Image panorama fallback");
    const ordinary = createNode("image", { x: 0, y: 0 }, { metadata: {
      content: "blob:ordinary",
      storageKey: "image:ordinary",
      naturalWidth: 1280,
      naturalHeight: 720,
    } });
    const spherical = createNode("image", { x: 0, y: 300 }, { metadata: {
      content: "blob:spherical",
      storageKey: "image:spherical",
      naturalWidth: 2048,
      naturalHeight: 1024,
      panoramaProjection: "equirectangular",
    } });
    const director = createNode("director", { x: 500, y: 0 });
    const connected = {
      ...project,
      nodes: [ordinary, spherical, director],
      edges: [
        { id: "edge_ordinary", from: ordinary.id, to: director.id },
        { id: "edge_spherical", from: spherical.id, to: director.id },
      ],
    };

    expect(isSphericalDirectorEnvironment(spherical)).toBe(true);
    expect(resolveDirectorPanorama(connected, director.id)?.id).toBe(spherical.id);
  });


  test("lists only connected image/panorama environments for a director", () => {
    const project = createProject("Connected environments");
    const connected = createNode("image", { x: 0, y: 0 }, { metadata: {
      content: "blob:connected",
      storageKey: "image:connected",
      naturalWidth: 1280,
      naturalHeight: 720,
    } });
    const unconnected = createNode("image", { x: 0, y: 200 }, { metadata: {
      content: "blob:other",
      storageKey: "image:other",
      naturalWidth: 800,
      naturalHeight: 600,
    } });
    const panorama = createNode("panorama", { x: 0, y: 400 }, { metadata: {
      content: "blob:panorama",
      storageKey: "image:panorama",
      naturalWidth: 2048,
      naturalHeight: 1024,
      panoramaProjection: "equirectangular",
    } });
    const director = createNode("director", { x: 500, y: 0 });
    const source = { ...project, nodes: [connected, unconnected, panorama, director] };
    expect(listDirectorEnvironmentOptions(source, director.id)).toEqual([]);

    const bound = bindDirectorPanorama(source, director.id, connected.id);
    expect(listDirectorEnvironmentOptions(bound, director.id).map((node) => node.id)).toEqual([connected.id]);

    const unbound = bindDirectorPanorama(bound, director.id, null);
    expect(listDirectorEnvironmentOptions(unbound, director.id)).toEqual([]);
  });

  test("adds multiple panorama edges without disturbing unrelated edges", () => {
    const project = createProject("Panorama shot");
    const first = createNode("panorama", { x: 0, y: 0 }, { metadata: { content: "blob:first", storageKey: "image:first", naturalWidth: 2048, naturalHeight: 1024 } });
    const second = createNode("panorama", { x: 0, y: 300 }, { metadata: { content: "blob:second", storageKey: "image:second", naturalWidth: 2048, naturalHeight: 1024 } });
    const director = createNode("director", { x: 500, y: 0 });
    const text = createNode("text", { x: -300, y: 0 });
    const source = {
      ...project,
      nodes: [first, second, director, text],
      edges: [{ id: "edge_text", from: text.id, to: director.id }],
    };
    const bound = bindDirectorPanorama(bindDirectorPanorama(source, director.id, first.id), director.id, second.id);
    expect(bound.edges.some((edge) => edge.from === first.id)).toBe(true);
    expect(bound.edges.some((edge) => edge.from === second.id)).toBe(true);
    expect(bound.edges.some((edge) => edge.id === "edge_text")).toBe(true);
    expect(resolveDirectorPanorama(bound, director.id)?.id).toBe(second.id);

    const bindingEdge = bound.edges.find((edge) => edge.from === second.id)!;
    const unbound = removeEdgeAndReconcilePanorama(bound, bindingEdge.id);
    // Active selection cleared; first environment edge remains and becomes the fallback.
    expect(resolveDirectorPanorama(unbound, director.id)?.id).toBe(first.id);
    expect(unbound.edges.some((edge) => edge.id === "edge_text")).toBe(true);
    expect(unbound.edges.some((edge) => edge.from === first.id)).toBe(true);
    expect(unbound.edges.some((edge) => edge.from === second.id)).toBe(false);
  });
});
