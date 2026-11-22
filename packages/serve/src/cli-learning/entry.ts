// Small hook entrypoint: do not load the server, runner, SQLite or provider SDKs for each local CLI event.
import { learningMain } from './cli.js';

const args = process.argv.slice(2);
process.exitCode = await learningMain(args[0] === 'learning' ? args.slice(1) : args);
