// recipe.mjs's types, for src/box-image.ts, which names the published image by the recipe's hash.
export declare const RECIPE: readonly string[];
export declare function recipeHash(dir?: string, dockerfile?: string): string;
export declare function instructionMatching(dockerfile: string, pattern: RegExp): string;
export declare function onImage(image: string, dockerfile?: string): string;
export declare function vendorDockerfile(base: string, options?: { agent?: readonly string[]; start?: readonly string[] }, dir?: string): { dockerfile: string; hash: string };
