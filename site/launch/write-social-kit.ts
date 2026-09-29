// Writes the launch social kit to docs/launch/social-kit.md. Run with `bun run launch:kit`.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderSocialKitMarkdown } from "./social-kit-markdown.ts";

export const SOCIAL_KIT_PATH = resolve(import.meta.dir, "../../docs/launch/social-kit.md");

if (import.meta.main) {
  await mkdir(resolve(SOCIAL_KIT_PATH, ".."), { recursive: true });
  await writeFile(SOCIAL_KIT_PATH, renderSocialKitMarkdown());
  console.log(`Wrote ${SOCIAL_KIT_PATH}`);
}
