// @novnc/novnc ships no types: only what HandoffView uses.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    viewOnly: boolean;
    scaleViewport: boolean;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
  }
}
