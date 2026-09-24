/**
 * Remembers which file each loaded catalog entity came from, so validation
 * problems can point at the file to fix. Entities built in memory have no source.
 */
const sources = new WeakMap<object, string>();

/** Path of the file (relative to the catalog root) an entity was loaded from. */
export function sourceOf(entity: object): string | undefined {
  return sources.get(entity);
}

export function setSource(entity: object, path: string): void {
  sources.set(entity, path);
}
