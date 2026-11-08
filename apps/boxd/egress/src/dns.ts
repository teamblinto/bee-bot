import * as NodeNet from "node:net";

const typeA = 1;
const classIn = 1;
const rcodeRefused = 5;
const rcodeNxdomain = 3;

// `address` answers A queries for the name; other types for it get an empty answer. `null` is
// NXDOMAIN. The proxy never recurses, so a name it does not know goes nowhere.
export type DnsAnswer = { address: string } | null;

export type DnsResult = { reply: Buffer; name: string; type: number; answer: string };

// One question, no compression in it, standard query. Anything else is dropped unanswered.
export function dnsReply(query: Buffer, answerFor: (name: string) => DnsAnswer): DnsResult | null {
  if (query.length < 17 || query.length > 512) {
    return null;
  }
  const flags = query.readUInt16BE(2);
  const isQuery = (flags & 0x8000) === 0;
  const opcode = (flags >> 11) & 0xf;
  if (!isQuery || query.readUInt16BE(4) !== 1 || query.readUInt16BE(6) !== 0) {
    return null;
  }
  const labels: string[] = [];
  let offset = 12;
  for (;;) {
    const length = query[offset];
    if (length === undefined || length > 63) {
      return null;
    }
    offset += 1;
    if (length === 0) {
      break;
    }
    if (offset + length > query.length) {
      return null;
    }
    labels.push(query.toString("latin1", offset, offset + length));
    offset += length;
  }
  if (offset + 4 > query.length || offset - 12 > 255) {
    return null;
  }
  const type = query.readUInt16BE(offset);
  const questionClass = query.readUInt16BE(offset + 2);
  const question = query.subarray(12, offset + 4);
  const name = labels.join(".").toLowerCase();

  const answer = opcode === 0 && questionClass === classIn ? answerFor(name) : null;
  const refused = opcode !== 0 || questionClass !== classIn;
  const withRecord = answer !== null && type === typeA && NodeNet.isIPv4(answer.address);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  // QR, opcode echoed, AA, RD echoed, RA clear.
  const rcode = refused ? rcodeRefused : answer === null ? rcodeNxdomain : 0;
  header.writeUInt16BE(0x8400 | (flags & 0x7900) | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(withRecord ? 1 : 0, 6);
  const parts = [header, question];
  if (withRecord) {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(typeA, 2);
    record.writeUInt16BE(classIn, 4);
    record.writeUInt32BE(30, 6);
    record.writeUInt16BE(4, 10);
    answer.address
      .split(".")
      .forEach((octet, index) => record.writeUInt8(Number(octet), 12 + index));
    parts.push(record);
  }
  return {
    reply: Buffer.concat(parts),
    name,
    type,
    answer: refused
      ? "REFUSED"
      : answer === null
        ? "NXDOMAIN"
        : withRecord
          ? answer.address
          : "empty",
  };
}

// For tests and the probe: a standard query for one name.
export function dnsQuery(id: number, name: string, type = typeA) {
  const labels = name.split(".").map((part) => {
    const bytes = Buffer.from(part, "latin1");
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(classIn, 3);
  return Buffer.concat([header, ...labels, tail]);
}
