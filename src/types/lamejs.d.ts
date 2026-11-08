declare module 'lamejs' {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, bitRate: number, options?: Record<string, unknown>);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
  export class WavHeader {
    static readHeader(dataView: DataView): unknown;
  }
}