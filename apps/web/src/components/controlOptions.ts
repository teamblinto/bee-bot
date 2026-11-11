import type { BotControl } from "@beebot/contracts";
import { Box, Globe, Monitor, Power } from "lucide-react";

// What each control mode is called wherever the owner picks one: the bot's settings and the
// panel beside its chat. `line` says where the bot works once it's picked.
export const controlOptions: Record<
  BotControl,
  { name: string; help: string; line: string; Icon: typeof Box }
> = {
  computer: {
    name: "Private desktop",
    help: "A Linux desktop of its own, with a browser, in a box apart from your computer",
    line: "A private Linux desktop on this device, separate from your own screen.",
    Icon: Box,
  },
  host: {
    name: "This PC",
    help: "Your screen and apps, only while you watch",
    line: "Your own screen and apps, only while you watch. Take control stops it.",
    Icon: Monitor,
  },
  browser: {
    name: "Browser",
    help: "Web pages only, in a box apart from your computer",
    line: "Web pages only, in a browser of its own, separate from yours.",
    Icon: Globe,
  },
  none: {
    name: "Off",
    help: "No browser or computer",
    line: "No screen. It works through chat and its other tools.",
    Icon: Power,
  },
};

// The order the panel's grid shows them in.
export const controlOrder: BotControl[] = ["computer", "host", "browser", "none"];
