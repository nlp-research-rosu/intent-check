// A mock of the Anthropic Messages API (node:http) for driving a real `claude -p` in probes and
// tests. Routed by request body, never by call order, because Claude Code makes side calls
// (titles, summaries, token counts) in an unpredictable order:
//   POST /v1/messages/count_tokens  -> { input_tokens }
//   POST /v1/messages, haiku model or no tools  -> a short text answer
//   POST /v1/messages, main model   -> a tool_use Write of src/a.js until a tool_result is in the
//                                      conversation, then a short end_turn text.
// Every request body is recorded in `requests`. Standalone: node test/helpers/mock-anthropic.js [port]
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hasToolResult = (messages) =>
  Array.isArray(messages) && messages.some((m) => m && Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result"));

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function head(model, id) {
  return ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
}

function textEvents(model, text, id) {
  return [
    head(model, id),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

function toolEvents(model, id, name, input) {
  return [
    head(model, id),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${id}`, name, input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

export function createMockAnthropic({ cwd = process.cwd(), file = "src/a.js", content = "export const a = 1;\n" } = {}) {
  const requests = [];
  let base = "";
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ }
      const pathname = new URL(req.url, "http://x").pathname;
      requests.push({ method: req.method, path: pathname, body });
      if (pathname === "/v1/messages/count_tokens") {
        const b = JSON.stringify({ input_tokens: 42 });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(b);
      }
      if (req.method === "POST" && pathname === "/v1/messages") {
        const model = (body && body.model) || "claude-mock";
        const id = `msg_mock${++n}`;
        const side = /haiku/i.test(model) || !(body && Array.isArray(body.tools) && body.tools.length);
        let events;
        if (side) events = textEvents(model, "Mock reply.", id);
        else if (!hasToolResult(body.messages)) events = toolEvents(model, id, "Write", { file_path: path.join(cwd, file), content });
        else events = textEvents(model, "Done.", id);
        if (!(body && body.stream)) {
          const msg = events.find((e) => e[0] === "message_start")[1].message;
          const blocks = events.filter((e) => e[0] === "content_block_start").map((e) => e[1].content_block);
          const text = events.find((e) => e[0] === "content_block_delta" && e[1].delta.type === "text_delta");
          const tool = events.find((e) => e[0] === "content_block_delta" && e[1].delta.type === "input_json_delta");
          if (tool) blocks[0].input = JSON.parse(tool[1].delta.partial_json);
          else if (text) blocks[0].text = text[1].delta.text;
          const stop = events.find((e) => e[0] === "message_delta")[1].delta.stop_reason;
          const b = JSON.stringify({ ...msg, content: blocks, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } });
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(b);
        }
        return sse(res, events);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no route" } }));
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
  const m = createMockAnthropic();
  m.listen(Number(process.argv[2] || 0)).then((u) => console.log(u));
}
