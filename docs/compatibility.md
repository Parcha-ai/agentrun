# Compatibility and maintenance

AgentRun is a Node.js ESM library. The supported floors are Node 22.19 and TypeScript 5.4 for TypeScript consumers; CI tests the Node floor and a TypeScript 5.4.5 consumer. Python, browser execution and a hosted runtime are not part of this beta.

The public interfaces are the package-root exports documented in each package README, the CLI commands, and the generated Workflow v2 schema. Internal source modules are not compatibility promises. Zod support is limited to JSON-representable contracts; intermediate state paths remain runtime-validated.

## Versions and stored workflows

Pin the package version with a stored workflow. The workflow digest identifies its document bytes, not the interpreter, adapters, tools or policies used to execute it. Record those versions separately. Matching `v: 2` documents may require different host capabilities; validate through the host that will actually run them.

This is a beta: API or execution changes can require migration between beta releases. Release notes must identify changes to graph validation, event shapes, schema conversion, effect identity or recovery. Do not upgrade the interpreter underneath an active persisted run. Retain its original implementation and receipts until it completes or is reconciled.

## Core and adapters

The core owns composition, validation and execution contracts. Jev and Pi remain optional adapters. Hosts own model configuration, tools and permissions, budgets, durable stores, activation and delivery. Neither a model verdict nor a completed workflow proves external delivery.

A separate interpreter may support fewer nodes even when it accepts Workflow v2 documents. Validate and test through the host that will execute the workflow. See [host integration](host-integration.md).

## Contributions and support

Use the [contribution checks](../CONTRIBUTING.md). Propose new execution behavior with a failing case and observable acceptance result, then retain existing behavior at its boundaries. Changes to providers belong at the existing adapter interfaces. The Parcha repository maintainers review changes; this beta carries no production support SLA.

Use repository issues for ordinary bugs with a minimal workflow and redacted input. Follow [SECURITY.md](../SECURITY.md) for sensitive reports; configure the private reporting route before the public launch. Do not put credentials, customer records or private SOPs in public reproductions.
