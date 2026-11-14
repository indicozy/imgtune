// The resource analyzers. Each stream adds one line here (see docs/superpowers/plans: the shared interface).
import type { ResourceAnalyzer } from "./types.js";
import { analyzer as compression } from "./compression.js";
import { analyzer as favicon } from "./favicon.js";

export type { ResourceAnalyzer, ResourceFinding, ResourceKind, ResourceRecord, PageContext } from "./types.js";

export const ANALYZERS: ResourceAnalyzer[] = [compression, favicon];
