import blueHeadphones from "../assets/avatars/blue-headphones.png";
import brownBeanie from "../assets/avatars/brown-beanie.png";
import coralMushroom from "../assets/avatars/coral-mushroom.png";
import indigoAntenna from "../assets/avatars/indigo-antenna.png";
import mintSprout from "../assets/avatars/mint-sprout.png";
import oliveFlower from "../assets/avatars/olive-flower.png";
import orangePocket from "../assets/avatars/orange-pocket.png";
import pinkBow from "../assets/avatars/pink-bow.png";
import plumCrown from "../assets/avatars/plum-crown.png";
import purpleScarf from "../assets/avatars/purple-scarf.png";
import skyCloud from "../assets/avatars/sky-cloud.png";
import slateGlasses from "../assets/avatars/slate-glasses.png";

// The image fills of Figma's "Bee Bot Avatar / …" components: 128px, 2x the largest designed size,
// round with the subtle edge baked in. A saved seed picks by position modulo the length, so
// reordering or resizing this list changes existing bots' faces.
export const avatars = [
  blueHeadphones,
  coralMushroom,
  purpleScarf,
  mintSprout,
  pinkBow,
  oliveFlower,
  orangePocket,
  indigoAntenna,
  skyCloud,
  brownBeanie,
  slateGlasses,
  plumCrown,
];

export const avatarIndex = (seed: number) => seed % avatars.length;

export const shuffledSeed = (seed: number) =>
  (avatarIndex(seed) + 1 + Math.floor(Math.random() * (avatars.length - 1))) % avatars.length;

export function Avatar({ seed, className = "size-8" }: { seed: number; className?: string }) {
  return (
    <img
      alt=""
      src={avatars[avatarIndex(seed)]}
      draggable={false}
      className={`shrink-0 select-none ${className}`}
    />
  );
}
