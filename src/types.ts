export const MAGIC_RESOURCE_TYPES = ['api', 'function', 'datasource', 'task'] as const;
export type MagicResourceType = typeof MAGIC_RESOURCE_TYPES[number];

export function isMagicResourceType(value: string): value is MagicResourceType {
    return (MAGIC_RESOURCE_TYPES as readonly string[]).includes(value);
}