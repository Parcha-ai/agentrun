// pdf_pages' name, in a leaf module that imports nothing, so the tool gate holds a call node's path (tool-gate.ts
// filedRefusal) without loading the tool and the Workspace with it: that import is a cycle back to the gate.

export const PDF_PAGES_TOOL = "pdf_pages";
