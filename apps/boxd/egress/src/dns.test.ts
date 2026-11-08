import { describe, expect, it } from "vite-plus/test";

import { dnsQuery, dnsReply } from "./dns.ts";

const known = (name: string) => (name === "api.anthropic.com" ? { address: "10.89.171.2" } : null);

describe("DNS answers", () => {
  it.each([
    ["api.anthropic.com", 1, 0, "10.89.171.2"],
    ["API.Anthropic.com", 1, 0, "10.89.171.2"],
    ["api.anthropic.com", 28, 0, "empty"],
    ["api.anthropic.com", 16, 0, "empty"],
    ["example.com", 1, 3, "NXDOMAIN"],
    ["exfil-c2VjcmV0.attacker.example", 16, 3, "NXDOMAIN"],
    ["api.anthropic.com.attacker", 1, 3, "NXDOMAIN"],
  ])("%s type %i -> rcode %i %s", (name, type, rcode, answer) => {
    const result = dnsReply(dnsQuery(0x1234, name, type), known);
    expect(result?.answer).toBe(answer);
    const reply = result?.reply ?? Buffer.alloc(12);
    expect(reply.readUInt16BE(0)).toBe(0x1234);
    expect(reply.readUInt16BE(2) & 0x8000).toBe(0x8000);
    expect(reply.readUInt16BE(2) & 0xf).toBe(rcode);
    expect(reply.readUInt16BE(6)).toBe(answer === "10.89.171.2" ? 1 : 0);
    if (answer === "10.89.171.2") {
      expect([...reply.subarray(-4)]).toEqual([10, 89, 171, 2]);
    }
  });

  it("drops what is not one plain question", () => {
    const query = dnsQuery(1, "api.anthropic.com");
    const response = Buffer.from(query);
    response.writeUInt16BE(0x8100, 2);
    const twoQuestions = Buffer.from(query);
    twoQuestions.writeUInt16BE(2, 4);
    const compressed = Buffer.concat([
      query.subarray(0, 12),
      Buffer.from([0xc0, 0x0c, 0, 1, 0, 1]),
    ]);
    const truncated = query.subarray(0, query.length - 3);
    const overlong = Buffer.concat([query.subarray(0, 12), Buffer.from([64]), Buffer.alloc(70)]);
    for (const packet of [
      response,
      twoQuestions,
      compressed,
      truncated,
      overlong,
      Buffer.alloc(3),
    ]) {
      expect(dnsReply(packet, known)).toBeNull();
    }
  });

  it("refuses other opcodes and classes without asking the policy", () => {
    const query = dnsQuery(1, "api.anthropic.com");
    query.writeUInt16BE(0x2800, 2);
    let asked = false;
    const result = dnsReply(query, () => {
      asked = true;
      return { address: "10.0.0.1" };
    });
    expect(result?.answer).toBe("REFUSED");
    expect(asked).toBe(false);
  });
});
