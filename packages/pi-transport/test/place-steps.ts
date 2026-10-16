import type { EnvironmentFacts, PlacementPhase, PlacementQuery } from "../src/place/placer.ts";

const facts = (id: string, purpose: string, more: Partial<EnvironmentFacts>): EnvironmentFacts => ({
	id,
	provider: "local",
	purpose,
	capabilities: [],
	gpu: null,
	cpus: null,
	memoryMb: null,
	isolation: null,
	region: null,
	...more,
});

/** Three places a session can run, each with its author's line. */
export const ENVIRONMENTS: readonly EnvironmentFacts[] = [
	facts("local", "This machine: reading and writing code, questions, small scripts and quick tests", { cpus: 2 }),
	facts("box", "A cloud box with 16 CPUs: long builds, long test suites and jobs that run for hours", {
		provider: "daytona",
		cpus: 16,
		memoryMb: 32_768,
	}),
	facts("gpu", "An H100 GPU machine: training or fine-tuning models and other GPU work", {
		provider: "modal",
		gpu: "H100",
		capabilities: ["gpu"],
	}),
];

const step = (current: string, phase: PlacementPhase, next: string): PlacementQuery => ({
	session: "replay",
	phase,
	what: "home",
	current,
	options: ENVIRONMENTS,
	next,
});

/** The steps of the replay set: clear needs, clear non-needs, the way back at a turn's end, and vague wording. */
export const STEPS: readonly PlacementQuery[] = [
	step("local", "message", "Fine-tune the classifier on the 40 GB dataset we downloaded."),
	step("local", "message", "Rename utils.py to helpers.py and fix the imports."),
	step("local", "message", "What does this error mean: ModuleNotFoundError: No module named 'torch'?"),
	step("local", "message", "Run the full integration test suite; it takes about two hours."),
	step("local", "message", "Summarize the README for me."),
	step("local", "message", "Generate embeddings for 2 million documents with the large embedding model."),
	step("local", "message", "Write a unit test for the parse function."),
	step("local", "message", "Train a small logistic regression on this 500-row CSV."),
	step("local", "message", "Compile the Rust project in release mode with LTO; it takes 40 minutes on a laptop."),
	step("local", "message", "Can you explain how the lease works?"),
	step("local", "message", "Benchmark the model's inference throughput on an H100."),
	step("local", "message", "Fix the typo in the docs."),
	step("local", "message", "Transcribe the 3-hour podcast with Whisper large."),
	step("local", "message", "Resize these 20 thumbnails."),
	step("local", "message", "Run the data pipeline over the full 1 TB dump; it takes all night."),
	step("local", "message", "Start a notebook to explore the data."),
	step("gpu", "message", "Now update the README with the new accuracy numbers."),
	step("gpu", "message", "Keep training for another 10 epochs."),
	step("gpu", "message", "Plot the loss curve from the training logs."),
	step("box", "message", "Train the model on the GPU now."),
	step("box", "message", "Rerun the failing test."),
	step("box", "message", "Translate this paragraph to Spanish."),
	step("gpu", "turn_end", "Training finished and the weights are saved. Next I will write the report."),
	step("gpu", "turn_end", "I need the GPU for the evaluation run that comes next."),
	step("gpu", "turn_end", "Done. Nothing else to run."),
	step("box", "turn_end", "The test suite passed. I will summarize the results."),
	step("box", "turn_end", "I need to run the nightly build again with more threads."),
	step("local", "turn_end", "Next I need to fine-tune the model on the new data."),
	step("local", "turn_end", "I will write the summary now."),
	step("local", "message", "Make it faster."),
	step("local", "message", "Do the heavy part."),
	step("local", "message", "Use the big machine for this."),
	step("local", "message", "Train it."),
	step("local", "message", "Run it overnight."),
	step("local", "message", "Process the images."),
	step("local", "message", "Index the codebase for search."),
	step("gpu", "turn_end", "Evaluate the model on the test set."),
	step("box", "message", "Profile the build and find the slowest step."),
	step("gpu", "message", "Write the model card."),
	step("box", "turn_end", "The build is green; the remaining work is a short changelog entry."),
];
