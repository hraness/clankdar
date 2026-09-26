import { attachStatusPage } from "@hraness/design-kit/browser";

// The 404 page's only script: the dot glyph, "Did you mean", and Back.
const enhance = () => document.querySelectorAll<HTMLElement>(".hraness-status-page").forEach(root => attachStatusPage(root));
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhance, { once: true });
else enhance();
