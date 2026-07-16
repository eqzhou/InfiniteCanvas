import type { ImageTransformCapability, ImageTransformProvider } from "./types";

export class ImageTransformRegistry {
  readonly #providers: ReadonlyMap<string, ImageTransformProvider>;

  constructor(providers: readonly ImageTransformProvider[] = []) {
    const map = new Map<string, ImageTransformProvider>();
    for (const provider of providers) {
      if (map.has(provider.id)) throw new Error(`Image transform provider already registered: ${provider.id}`);
      map.set(provider.id, provider);
    }
    this.#providers = map;
  }

  get(id: string): ImageTransformProvider | undefined {
    return this.#providers.get(id);
  }

  forCapability(capability: ImageTransformCapability): ImageTransformProvider[] {
    return [...this.#providers.values()].filter((provider) => provider.capabilities[capability]);
  }

  register(provider: ImageTransformProvider): ImageTransformRegistry {
    if (this.#providers.has(provider.id)) throw new Error(`Image transform provider already registered: ${provider.id}`);
    return new ImageTransformRegistry([...this.#providers.values(), provider]);
  }
}
