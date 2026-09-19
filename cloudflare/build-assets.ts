/** Package the existing site's pinned shared presentation for same-origin Worker profiles. */
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
const root = import.meta.dir;
const output = resolve(root, "assets");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const path of ["design", "marks", "icon.png", "styles.css", "footer.css", "appearance.js"]) {
  await cp(resolve(root, "../site/dist", path), resolve(output, path), { recursive: true });
}
await cp(resolve(root, "profile.css"), resolve(output, "profile.css"));
console.log("Packaged same-origin profile assets from the pinned site build.");
