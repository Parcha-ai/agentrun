// Loaded in a child with `node --import`: installs the crossing function before the child's own code runs.
import { installCrossing } from "./crash-points.js";

installCrossing();
