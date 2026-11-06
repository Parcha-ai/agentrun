export type TokenFiles = { tokensCss: string; vocabularyText: string; stylesCss: string };
export const TOKENS_CSS: string;
export const VOCABULARY: string;
export const STYLES_CSS: string;
export function declaredProperties(css: string): Set<string>;
export function checkTokenFiles(files: TokenFiles): string[];
export function readTokenFiles(consoleDir: string | URL): TokenFiles;
export function checkTokens(consoleDir: string | URL): string[];
