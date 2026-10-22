#!/usr/bin/env node
import { main } from "./command.js";

process.exitCode = await main(process.argv.slice(2));
