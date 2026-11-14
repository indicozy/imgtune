// The resource analyzers. Each stream adds one line here (see docs/superpowers/plans: the shared interface).
import type { ResourceAnalyzer } from "./types.js";
import { analyzer as audio } from "./audio.js";
import { analyzer as compression } from "./compression.js";
import { analyzer as favicon } from "./favicon.js";
import { analyzer as font } from "./font.js";
import { analyzer as lottie } from "./lottie.js";
import { analyzer as model } from "./model.js";
import { analyzer as svg } from "./svg.js";

export type { ResourceAnalyzer, ResourceFinding, ResourceKind, ResourceRecord, PageContext } from "./types.js";

export const ANALYZERS: ResourceAnalyzer[] = [compression, favicon, font, lottie, svg, model, audio];
