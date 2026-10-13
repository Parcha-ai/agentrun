// Every case the rig runs. A case is a job, the fakes it runs on, and what its run must show.
import { loginWall } from './login-wall.ts';
import { noVisionRoute } from './no-vision-route.ts';
import { searchFails } from './search-fails.ts';

export const cases = [loginWall, noVisionRoute, searchFails];
