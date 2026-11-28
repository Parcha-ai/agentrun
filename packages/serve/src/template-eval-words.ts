// The template eval's words a caller checks before it loads the eval (cli.ts eval-template refuses its flags first): this
// module imports nothing, so a refused call costs no load of template-eval.ts.

/** An owner's data folder is the eval's own server's to open (EvalOptions.data): a named server keeps its own. */
export const ON_DATA_WITH_SERVER = "--on-data is the data folder of the eval's own server, and --server names another server: give one of them";
