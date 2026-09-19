import { b64url, canonical, sha256, sha256Bytes, unb64url } from "./protocol.ts";

export const CAMPAIGN_PROTOCOL = "clankdar-campaign-v1";
export const SCHEDULE_DOMAIN = "clankdar/campaign-schedule/v1";

export interface CampaignConfig {
  policyId: string;
  epochs: number;
  cadenceSeconds: number;
  windowSeconds: number;
  startsAt: string;
}

export interface EpochWindow { epoch: number; opensAt: string; closesAt: string }

export const newScheduleSeed = (): string => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const scheduleCommit = (campaignId: string, seed: string) => sha256(canonical([SCHEDULE_DOMAIN, campaignId, seed]));

export function parseCampaignConfig(value: unknown, now = new Date()): CampaignConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("campaign is malformed");
  const body = value as Partial<CampaignConfig> & { startDelaySeconds?: unknown };
  if (typeof body.policyId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.policyId)) throw new Error("policyId is malformed");
  if (!Number.isInteger(body.epochs) || (body.epochs as number) < 1 || (body.epochs as number) > 10_000) throw new Error("epochs must be 1..10000");
  if (!Number.isInteger(body.cadenceSeconds) || (body.cadenceSeconds as number) < 60 || (body.cadenceSeconds as number) > 86_400) throw new Error("cadenceSeconds must be 60..86400");
  if (!Number.isInteger(body.windowSeconds) || (body.windowSeconds as number) < 30 || (body.windowSeconds as number) > (body.cadenceSeconds as number)) throw new Error("windowSeconds must be 30..cadenceSeconds");
  const delay = body.startDelaySeconds === undefined ? 10 : Number(body.startDelaySeconds);
  if (!Number.isInteger(delay) || delay < 0 || delay > 86_400) throw new Error("startDelaySeconds must be 0..86400");
  return { policyId: body.policyId, epochs: body.epochs as number, cadenceSeconds: body.cadenceSeconds as number, windowSeconds: body.windowSeconds as number, startsAt: new Date(now.getTime() + delay * 1000).toISOString() };
}

export async function epochWindow(config: CampaignConfig, scheduleSeed: string, epoch: number): Promise<EpochWindow> {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch >= config.epochs) throw new Error("epoch is out of range");
  const index = new Uint8Array(4);
  new DataView(index.buffer).setUint32(0, epoch);
  const seed = unb64url(scheduleSeed);
  if (seed.length !== 32) throw new Error("schedule seed is malformed");
  const combined = new Uint8Array(seed.length + index.length);
  combined.set(seed); combined.set(index, seed.length);
  const digest = await sha256Bytes(combined);
  const room = config.cadenceSeconds - config.windowSeconds;
  const offset = room === 0 ? 0 : new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0) % (room + 1);
  const opens = Date.parse(config.startsAt) + (epoch * config.cadenceSeconds + offset) * 1000;
  return { epoch, opensAt: new Date(opens).toISOString(), closesAt: new Date(opens + config.windowSeconds * 1000).toISOString() };
}
