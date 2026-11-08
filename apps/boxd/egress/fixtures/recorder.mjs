// Stands in for a vendor API or an attacker in the Podman test. Logs one line per request, with
// only whether the expected key arrived, never the header itself.
import { createHash } from "node:crypto";
import http from "node:http";

const expected = process.env.EXPECT_KEY_SHA ?? "";

http
  .createServer((request, response) => {
    const key = String(request.headers["x-api-key"] ?? "");
    const keySha = key === "" ? "" : createHash("sha256").update(key).digest("hex");
    process.stdout.write(
      `${JSON.stringify({
        url: request.url,
        host: request.headers.host,
        keyMatches: keySha !== "" && keySha === expected,
        hasKey: key !== "",
      })}\n`,
    );
    response.end("ok");
  })
  .listen(9000);
