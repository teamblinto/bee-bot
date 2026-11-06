import type { CSSProperties, ReactNode } from "react";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const leftEye = 11.5;
const rightEye = 20.5;
const eyeY = 14;
const mouthY = 21;

// The order and length of these lists decide every saved bot's face: reordering or resizing one
// changes existing faces, so only ever replace an entry's drawing.
const bodies = [
  "M16 2.5C24.5 2.5 29.5 7.5 29.5 16S24.5 29.5 16 29.5 2.5 24.5 2.5 16 7.5 2.5 16 2.5Z",
  "M16 1.5C22.5 1.5 27.5 9.5 27.5 18C27.5 25.5 22.5 30 16 30S4.5 25.5 4.5 18C4.5 9.5 9.5 1.5 16 1.5Z",
  "M9 5.5H23C28 5.5 31.5 10 31.5 16S28 26.5 23 26.5H9C4 26.5 .5 22 .5 16S4 5.5 9 5.5Z",
  "M11 4.5C13.5 1.5 18.5 1.5 21 4.5C25 3.5 28.5 7 27.5 11C30.5 13.5 30.5 18.5 27.5 21C28.5 25 25 28.5 21 27.5C18.5 30.5 13.5 30.5 11 27.5C7 28.5 3.5 25 4.5 21C1.5 18.5 1.5 13.5 4.5 11C3.5 7 7 3.5 11 4.5Z",
  "M16 2C20.5 2 23.5 5 24 9C24.3 11.5 27 14 27.8 18C29 24.5 23.5 30 16 30S3 24.5 4.2 18C5 14 7.7 11.5 8 9C8.5 5 11.5 2 16 2Z",
  "M7.5 4.5C12 2 23 1.5 26.5 5C30 8.5 30 21 27 25.5C24 29.5 11 30.5 6.5 27.5C2 24.5 3 7 7.5 4.5Z",
  "M16 2.5C23.5 2.5 29 9.5 29 18.5C29 25 28 28.5 24 29C19.5 29.5 12.5 29.5 8 29C4 28.5 3 25 3 18.5C3 9.5 8.5 2.5 16 2.5Z",
  "M16 2.5C23 2.5 27.5 7.5 27.5 14.5V25.5C27.5 28.5 24.5 29.5 22.7 27.5C21 25.7 19.2 25.7 17.8 27.7C16.8 29 15.2 29 14.2 27.7C12.8 25.7 11 25.7 9.3 27.5C7.5 29.5 4.5 28.5 4.5 25.5V14.5C4.5 7.5 9 2.5 16 2.5Z",
];

const pair = (draw: (x: number) => ReactNode) => (
  <>
    {draw(leftEye)}
    {draw(rightEye)}
  </>
);

const eyes: ReactNode[] = [
  pair((x) => <circle cx={x} cy={eyeY} r={2} fill="currentColor" />),
  pair((x) => <ellipse cx={x} cy={eyeY} rx={1.7} ry={2.8} fill="currentColor" />),
  pair((x) => (
    <path d={`M${x - 2.4} ${eyeY + 1}Q${x} ${eyeY - 3} ${x + 2.4} ${eyeY + 1}`} {...stroke} />
  )),
  <g key="wink">
    <circle cx={leftEye} cy={eyeY} r={2} fill="currentColor" />
    <path
      d={`M${rightEye - 2.4} ${eyeY}Q${rightEye} ${eyeY + 2.6} ${rightEye + 2.4} ${eyeY}`}
      {...stroke}
    />
  </g>,
  pair((x) => <path d={`M${x - 2.4} ${eyeY}H${x + 2.4}`} {...stroke} />),
  pair((x) => (
    <>
      <circle cx={x} cy={eyeY} r={3} fill="currentColor" />
      <circle cx={x + 1} cy={eyeY - 1} r={1} className="avatar-body" />
    </>
  )),
  pair((x) => (
    <path d={`M${x - 2.2} ${eyeY - 1}Q${x} ${eyeY + 3} ${x + 2.2} ${eyeY - 1}`} {...stroke} />
  )),
  <g key="close">
    <circle cx={13} cy={eyeY} r={2} fill="currentColor" />
    <circle cx={19} cy={eyeY} r={2} fill="currentColor" />
  </g>,
];

const mouths: ReactNode[] = [
  <path key="smile" d={`M11.5 ${mouthY - 1}Q16 ${mouthY + 3.5} 20.5 ${mouthY - 1}`} {...stroke} />,
  <path
    key="open"
    d={`M12 ${mouthY - 1.5}H20Q20 ${mouthY + 4} 16 ${mouthY + 4}T12 ${mouthY - 1.5}Z`}
    fill="currentColor"
  />,
  <circle key="oh" cx={16} cy={mouthY} r={1.8} fill="currentColor" />,
  <path
    key="smirk"
    d={`M12.5 ${mouthY + 0.5}Q17 ${mouthY + 1.5} 19.5 ${mouthY - 1.5}`}
    {...stroke}
  />,
  <path
    key="cat"
    d={`M11.5 ${mouthY - 0.5}Q13.8 ${mouthY + 2.5} 16 ${mouthY}Q18.2 ${mouthY + 2.5} 20.5 ${mouthY - 0.5}`}
    {...stroke}
  />,
  <path key="tiny" d={`M14 ${mouthY}Q16 ${mouthY + 2} 18 ${mouthY}`} {...stroke} />,
];

const accessories: ReactNode[] = [
  null,
  <g key="sprout">
    <path d="M16 7V0" {...stroke} className="avatar-accent-line" />
    <path d="M16 .5C16 -3 19.5 -4.5 22.5 -4C22.5 -1 20 1 16 .5Z" className="avatar-accent" />
  </g>,
  <g key="antenna">
    <path d="M16 7V-1" {...stroke} className="avatar-accent-line" />
    <circle cx={16} cy={-2} r={2.4} className="avatar-accent" />
  </g>,
  <path
    key="bow"
    d="M16 3.2C13.5 .5 9.5 -.5 9 2.4C8.6 5 12.5 5.6 16 3.8C19.5 5.6 23.4 5 23 2.4C22.5 -.5 18.5 .5 16 3.2Z"
    className="avatar-accent"
  />,
  pair((x) => (
    <circle cx={x + (x < 16 ? -3.2 : 3.2)} cy={19.5} r={2.3} fill="currentColor" opacity={0.28} />
  )),
  <g key="freckles">
    <circle cx={6.5} cy={19} r={1} className="avatar-accent" />
    <circle cx={9} cy={20.5} r={1} className="avatar-accent" />
    <circle cx={23} cy={20.5} r={1} className="avatar-accent" />
    <circle cx={25.5} cy={19} r={1} className="avatar-accent" />
  </g>,
  <path key="cap" d="M8 5.5C9 -1 23 -1 24 5.5C20 3.8 12 3.8 8 5.5Z" className="avatar-accent" />,
  <path
    key="sparkle"
    d="M22 -4.5L23 -2L25.5 -1L23 0L22 2.5L21 0L18.5 -1L21 -2Z"
    className="avatar-accent"
  />,
];

function mix(seed: number, salt: number, size: number) {
  let hash = (seed ^ Math.imul(salt, 2654435761)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 2246822519) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 3266489917) >>> 0;
  return ((hash ^ (hash >>> 16)) >>> 0) % size;
}

export const avatarParts = (seed: number) => ({
  body: mix(seed, 1, bodies.length),
  eyes: mix(seed, 2, eyes.length),
  mouth: mix(seed, 3, mouths.length),
  accessory: mix(seed, 4, accessories.length),
  hue: mix(seed, 5, 360),
});

export const avatarPartCounts = {
  body: bodies.length,
  eyes: eyes.length,
  mouth: mouths.length,
  accessory: accessories.length,
};

export function Avatar({ seed, className = "size-8" }: { seed: number; className?: string }) {
  const parts = avatarParts(seed);
  return (
    <svg
      aria-hidden
      viewBox="-2 -5 36 36"
      className={`avatar shrink-0 ${className}`}
      style={{ "--hue": parts.hue } as CSSProperties}
    >
      <path d={bodies[parts.body]} className="avatar-body" />
      {accessories[parts.accessory]}
      {eyes[parts.eyes]}
      {mouths[parts.mouth]}
    </svg>
  );
}
