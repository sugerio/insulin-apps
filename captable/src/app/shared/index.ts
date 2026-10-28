// Shared API schemas and the cap-table engine, used by the web app and the Worker (the design rules).
// The API contract, the engine and the OCF pin are namespaces, so names they share (IsoDate, PlanReturnRules,
// VestingDefinition, Dec, …) never collide.
export * as api from "./api/index.ts";
export * as engine from "./engine/index.ts";
export * as ocf from "./ocf/index.ts";
// The names the platform shell imported before the full contract landed, as aliases of the same schemas.
export * from "./aliases.ts";
