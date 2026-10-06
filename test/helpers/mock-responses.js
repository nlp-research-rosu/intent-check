// A mock of the OpenAI Responses API (node:http, SSE) for driving a real `codex exec` through a custom
// model provider. Routed by request body, never by call order:
//   POST /v1/responses -> an apply_patch (via exec_command) call that adds `file` until a tool output is in the
//                         conversation, then a short assistant message.
// Every request body is recorded in `requests`. Standalone: node test/helpers/mock-responses.js [port]
import http from "node:http";
import { fileURLToPath } from "node:url";

const hasToolOutput = (input) => Array.isArray(input) && input.some((i) => i && /_output$/.test(i.type || ""));

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

const completed = (id) => ({ type: "response.completed", response: { id, object: "response", status: "completed", usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 } } });

export function createMockResponses({ file = "src/a.js", content = "export const a = 1;\n" } = {}) {
  const requests = [];
  let base = "";
  let n = 0;
  const patch = `*** Begin Patch\n*** Add File: ${file}\n${content.replace(/\n$/, "").split("\n").map((l) => `+${l}`).join("\n")}\n*** End Patch\n`;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json (or zstd) */ }
      const pathname = new URL(req.url, "http://x").pathname;
      requests.push({ method: req.method, path: pathname, body, raw: Buffer.concat(chunks).toString("latin1") });
      if (req.method === "POST" && /\/responses$/.test(pathname)) {
        const id = `resp_mock${++n}`;
        const created = { type: "response.created", response: { id } };
        if (body && hasToolOutput(body.input)) {
          const item = { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: "Done." }] };
          return sse(res, [created, { type: "response.output_item.done", item }, completed(id)]);
        }
        // Codex intercepts `apply_patch <<'EOF' ...` run through its exec_command tool and applies it
        // as a patch (the tool_name its hooks see is apply_patch), which works for any model name.
        // Newer models get apply_patch as a freeform (custom) tool: call that directly.
        const raw = Buffer.concat(chunks).toString("latin1");
        const item = /"type":"custom","name":"apply_patch"/.test(raw)
          ? { type: "custom_tool_call", call_id: `call_${n}`, name: "apply_patch", input: patch }
          : { type: "function_call", call_id: `call_${n}`, name: "exec_command", arguments: JSON.stringify({ cmd: `apply_patch <<'EOF'\n${patch}EOF\n` }) };
        return sse(res, [created, { type: "response.output_item.done", item }, completed(id)]);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no route", type: "not_found" } }));
    });
  });
  return {
    requests,
    get url() { return base; },
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve(base);
      }));
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const m = createMockResponses();
  m.listen(Number(process.argv[2] || 0)).then((u) => console.log(u));
}
