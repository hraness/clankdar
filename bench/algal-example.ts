#!/usr/bin/env bun
/** Run the public worked example through the pinned Algal WASM evaluator; no model calls. */
import { algalWorkedExample } from "../ladder/families/algal.ts";

if (import.meta.main) console.log(JSON.stringify(algalWorkedExample(), null, 2));
