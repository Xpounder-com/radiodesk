export interface RadioDeskModule { id: string; name: string; capabilities: string[]; start?(): Promise<void>; stop?(): Promise<void>; }
export class ModuleRegistry {
  private modules = new Map<string, RadioDeskModule>();
  register(module: RadioDeskModule): void {
    if (this.modules.has(module.id)) throw new Error(`Module ${module.id} is already registered`);
    this.modules.set(module.id, module);
  }
  list(): RadioDeskModule[] { return [...this.modules.values()]; }
  capableOf(capability: string): RadioDeskModule[] { return this.list().filter(module => module.capabilities.includes(capability)); }
}
