import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CapabilityRegistrySchema, type CapabilityRegistry, type RegistryModel } from './types.js';

export class RegistryStore {
  private registry: CapabilityRegistry | null = null;
  private loadedAt: string | null = null;

  constructor(private readonly registryPath: string) {}

  async load(): Promise<CapabilityRegistry> {
    const fullPath = path.resolve(this.registryPath);
    const parsed = CapabilityRegistrySchema.parse(JSON.parse(await readFile(fullPath, 'utf8')));
    const ids = new Set<string>();
    for (const model of parsed.models) {
      if (ids.has(model.id)) throw new Error(`Duplicate model id in registry: ${model.id}`);
      ids.add(model.id);
    }
    this.registry = parsed;
    this.loadedAt = new Date().toISOString();
    return parsed;
  }

  async reload(): Promise<{ registry: CapabilityRegistry; loadedAt: string }> {
    const registry = await this.load();
    return { registry, loadedAt: this.loadedAt ?? new Date().toISOString() };
  }

  get(): CapabilityRegistry {
    if (!this.registry) throw new Error('Capability registry has not been loaded');
    return this.registry;
  }

  getLoadedAt(): string | null {
    return this.loadedAt;
  }

  findModel(id: string): RegistryModel | undefined {
    const registry = this.get();
    return registry.models.find((model) => model.id === id || model.aliases?.includes(id));
  }
}
