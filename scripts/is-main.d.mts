/** Whether the module whose `import.meta` this is runs as the command; on a Node without it, the command refuses. */
export declare function isMain(meta: { readonly url: string; readonly main?: boolean }): boolean;
