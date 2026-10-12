// The robot demo's standing instructions for the cloud agent, bundled into the page as text (esbuild's .md loader): how to write the robot as code and how to plan a teaching run.
// The threads' own SOP (train-skill.md) belongs to the VM host, not to this page.
import robot from "../../04-walks-home/cluster/sop/robot.md";
import teach from "../../04-walks-home/cluster/sop/teach.md";

export const ROBOT_SOPS = `${robot.trim()}\n\n${teach.trim()}`;
