import type { ActorState } from "./actor.ts";

export interface Env {
  ASSETS?: Fetcher;
  ACTORS: DurableObjectNamespace<ActorState>;
  REGISTRY: D1Database;
  EVIDENCE: R2Bucket;
  ENVIRONMENT: string;
  ISSUER_JWK: string;
  SESSION_WRAP_KEY: string;
  REGISTRATION_TOKEN: string;
  MAX_BODY_BYTES: string;
  HEARTBEAT_MIN_SECONDS: string;
}
