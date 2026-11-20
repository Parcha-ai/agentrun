---
packages: @parcha/agentrun-serve, @parcha/agentrun-dsl
kind: feature
---
A schedule trigger's next run keeps what its last answer carried when that answer is over 32 KiB. An agent's `output_schema` may name, in `x-carried`, the top-level fields its next run reads back (a watch's `seen`, a digest's `open_urgent`). When the last completed result is over the limit, the next run is handed those fields alone, read from the schema of the run that produced it (its revision's, not the agent's current one), with words naming them and the whole result's size. With no `x-carried`, or carried fields that are themselves over the limit, the run is told the result was too large, as before; under the limit it is handed whole, as before.
A save refuses an `x-carried` that is not an array of unique names of the schema's root `properties` (`422 input_invalid`, field `definition.output_schema.x-carried`). `submitParameters` leaves `x-carried` out of a submit tool's schema, as it does `criteria`, so a learned workflow that copies the agent's output schema never sends a provider a keyword it does not know.
