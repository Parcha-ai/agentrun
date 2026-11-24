// Matched anywhere in the id, so a Bedrock, Vertex or OpenRouter name ("us.anthropic.claude-haiku-5-5-v1:0") reads as its model.
/** Opus 4.7 and later, the Claude 5 family, Fable and Mythos: a request with a (non-default) temperature is a 400. */
const REFUSES_TEMPERATURE = /claude-(?:fable|mythos|(?:opus|sonnet|haiku)-5|opus-4-[7-9])(?![0-9])/;
/** Opus 4.5 and later, Sonnet 4.6 and later, the Claude 5 family, Fable and Mythos. */
const TAKES_EFFORT = /claude-(?:fable|mythos|(?:opus|sonnet|haiku)-5|opus-4-[5-9]|sonnet-4-[6-9])(?![0-9])/;

/** The temperature to send `model`: 0 where it takes one, none where it refuses one. */
export const temperatureFor = (model: string): 0 | undefined => (REFUSES_TEMPERATURE.test(model) ? undefined : 0);
export const takesEffort = (model: string): boolean => TAKES_EFFORT.test(model);

export type TemperatureRecord = { temperature_sent: number | null; temperature_applied: boolean | "unknown" };
/** `direct`: the request went to Anthropic itself. A proxy may drop the field silently, so through one it is unknown. */
export const temperatureRecord = (sent: number | undefined, direct: boolean): TemperatureRecord => ({
  temperature_sent: sent ?? null,
  temperature_applied: sent === undefined ? false : direct ? true : "unknown",
});
