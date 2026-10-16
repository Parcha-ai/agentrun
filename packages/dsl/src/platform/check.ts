// Both platforms satisfy one contract: a change to one file that the other lacks fails the build here.
import type { Platform } from "./contract.js";
import * as browser from "./browser.js";
import * as node from "./node.js";

export const browserPlatform: Platform = browser;
export const nodePlatform: Platform = node;
