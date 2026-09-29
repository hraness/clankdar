import { paletteColors } from "@hraness/design-kit";
import { attachFoil, installAppearanceMenus } from "@hraness/design-kit/browser";
installAppearanceMenus({ lightThemeColor: paletteColors["tokyo-night"].light.background, darkThemeColor: paletteColors["tokyo-night"].dark.background });

attachFoil(document.documentElement);
