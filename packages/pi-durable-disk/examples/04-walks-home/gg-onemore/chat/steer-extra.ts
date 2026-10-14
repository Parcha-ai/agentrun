// The any-topic page's part of the cloud app on the Modal VM (`DEMO_APP_EXTRA`): the Golden Gate page's extra (gg-extra.ts)
// with the any-topic page's words (steer-text.ts): its instructions, the obsession skill, and the header named after what
// is served. Same environment as gg-extra.ts.
import { pageApp } from "./gg-extra.ts";
import { STEER_PAGE } from "./steer-text.ts";

export default pageApp(STEER_PAGE);
