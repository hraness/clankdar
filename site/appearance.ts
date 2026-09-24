import { paletteColors } from "@hraness/design-kit";
import { attachHeroLight, installAppearanceMenus } from "@hraness/design-kit/browser";
installAppearanceMenus({ lightThemeColor: paletteColors["tokyo-night"].light.background, darkThemeColor: paletteColors["tokyo-night"].dark.background });

const enhanceHeroes = () => document.querySelectorAll<HTMLElement>("[data-hraness-hero]").forEach(attachHeroLight);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhanceHeroes, { once: true });
else enhanceHeroes();
