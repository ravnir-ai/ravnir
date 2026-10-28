import http from "node:http";

export function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        sendJson(res, 200, { data: [{ id: "mock-model", name: "Mock model" }, { id: "mock-coder", name: "Mock coder" }] });
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = JSON.parse(await readBody(req));
        // "blind model" in a message with photos: answer like a provider whose model cannot take images.
        const parts = (body.messages || []).flatMap((message) => (Array.isArray(message.content) ? message.content : []));
        if (parts.some((part) => part.type === "image_url") && parts.some((part) => /blind model/.test(part.text || ""))) {
          sendJson(res, 400, { error: { message: "This model does not support image input." } });
          return;
        }
        writeStream(res, script(body));
        return;
      }
      sendJson(res, 404, { error: { message: "not found" } });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function script(body) {
  const messages = body.messages || [];
  const lastMessage = messages.at(-1);
  // The computer chooser: click "Next" while there is one, then DONE.
  if (String(messages[0]?.content || "").includes("You choose the next action")) {
    const asked = String(lastMessage?.content || "");
    const lines = asked.split("Actions:\n").at(-1).split("\n");
    // "keep tabbing" presses Tab forever, so tests can see a loop that changes nothing stop.
    // "open the about page" clicks About once, then reads done_so_far and says DONE.
    let next;
    if (asked.includes("Goal: keep tabbing")) next = lines.find((line) => line.includes("Press Tab"));
    else if (asked.includes("Goal: open the about page")) {
      next = asked.includes("done_so_far: 1.") ? lines.find((line) => line.includes("DONE")) : lines.find((line) => line.includes('Click "About"')) || lines[0];
    } else next = lines.find((line) => line.includes('Click "Next"')) || lines.find((line) => line.includes("DONE"));
    const pick = Number(String(next || "1").split(".")[0]);
    return [chunk({ content: `<think>Looking at the page.</think>{"pick": ${pick}, "score": 4}` }), chunk({}, "stop"), "[DONE]"];
  }
  // The quick plan an agent sends before it starts working.
  if (String(messages[0]?.content || "").includes("Write the first thing they see")) {
    const latest = String(lastMessage?.content || "").split("Latest message:\n").at(-1);
    if (/^(hi|hello|thanks)\b/i.test(latest)) return [chunk({ content: "SKIP" }), chunk({}, "stop"), "[DONE]"];
    return [chunk({ content: "Okay. I'll take care of that now." }), chunk({}, "stop"), "[DONE]"];
  }
  if (lastMessage?.role === "tool") {
    if (String(lastMessage.tool_call_id || "").startsWith("mcp_")) {
      return [chunk({ content: `The tool said: ${lastMessage.content}` }), chunk({}, "stop"), "[DONE]"];
    }
    if (String(lastMessage.tool_call_id || "").startsWith("call_tool_")) {
      return [chunk({ content: `Tool result: ${lastMessage.content}` }), chunk({}, "stop"), "[DONE]"];
    }
    return [chunk({ content: "Wrote the file." }), chunk({}, "stop"), "[DONE]"];
  }
  const found = [...messages].reverse().find((message) => message.role === "user");
  // Ravnir's notes (the message's language, the quick plan) ride along at the end of the message; the scripts match the message itself.
  // A message with photos arrives as parts; the reply names them as [image] so tests can see they came through.
  const flat = (content) => (Array.isArray(content) ? content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ") : String(content || ""));
  const user = found && { ...found, content: flat(found.content).replace(/\n\n\(Reply in [^\n]*\)(?=\n\n|$)/, "").replace(/\n\n\(You already told the user: [\s\S]*\)$/, "") };
  const text = String(user?.content || "").toLowerCase();
  const tools = body.tools || [];
  const messageBot = tools.find((tool) => tool.function?.name === "message_bot");
  if (messageBot && text.includes("message teammate")) {
    return [
      chunk({
        tool_calls: [{
          index: 0,
          id: "mcp_message_bot",
          type: "function",
          function: { name: "message_bot", arguments: JSON.stringify({ bot: "Receiver", text: "ping from sender", wait: true }) },
        }],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ];
  }
  const createBot = tools.find((tool) => tool.function?.name === "create_bot");
  if (createBot && text.includes("create teammate")) {
    return [
      chunk({
        tool_calls: [{
          index: 0,
          id: "mcp_create_bot",
          type: "function",
          function: { name: "create_bot", arguments: JSON.stringify({ name: "Scout Two", job: "Helps the team.", group: "QA" }) },
        }],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ];
  }
  // A message that answers the agent's open question carries a note for the model (server/turn.js).
  const answered = /\n\n\(This message answers what you asked the user: ([\s\S]*?)\. Continue the work with it\.( If it gives a lasting fact about the user, save it with remember first \(key: ([^)]*)\)\.)?\)/.exec(String(user?.content || ""));
  if (answered) {
    return [chunk({ content: `Thanks. That answers ${answered[1]}.${answered[3] ? ` Saving it as ${answered[3]}.` : ""}` }), chunk({}, "stop"), "[DONE]"];
  }
  // "call tool NAME {json}" calls any offered tool, so tests can drive one tool end to end.
  const callMatch = String(user?.content || "").match(/^call tool ([a-z0-9_]+) (\{.*\})$/is);
  if (callMatch && tools.some((tool) => tool.function?.name === callMatch[1])) {
    return [
      chunk({ tool_calls: [{ index: 0, id: `call_tool_${callMatch[1]}`, type: "function", function: { name: callMatch[1], arguments: callMatch[2] } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ];
  }
  const runCommand = tools.find((tool) => tool.function?.name === "run_command");
  const commandMatch = String(user?.content || "").match(/run command: (.+)$/i);
  if (runCommand && commandMatch) {
    return [
      chunk({
        tool_calls: [{
          index: 0,
          id: "mcp_run_command",
          type: "function",
          function: { name: "run_command", arguments: JSON.stringify({ command: commandMatch[1] }) },
        }],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ];
  }
  const echo = tools.find((tool) => tool.function?.name?.includes("echo"));
  if (tools.length && text.includes("echo") && echo) {
    return [
      chunk({
        tool_calls: [{
          index: 0,
          id: echo.function.name,
          type: "function",
          function: { name: echo.function.name, arguments: JSON.stringify({ text: "from mcp" }) },
        }],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ];
  }
  const write = tools.find((tool) => tool.function?.name === "write_file");
  // The note about attached files mentions "file"; it is not a request to write one.
  const asked = text.replace(/\[the user attached[\s\S]*$/, "");
  if (write && (asked.includes("create") || asked.includes("write") || asked.includes("file"))) {
    return [
      chunk({
        tool_calls: [{
          index: 0,
          id: "call_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "hello.txt", content: "hello from ravnir\n" }),
          },
        }],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ];
  }
  return [chunk({ content: `Mock reply: ${user?.content || ""}` }), chunk({}, "stop"), "[DONE]"];
}

function chunk(delta, finish) {
  return {
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  };
}

// Every reply reports usage the way OpenAI and OpenRouter do: a last chunk with no choices.
const USAGE = { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.002 } };

function writeStream(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const withUsage = [...events];
  withUsage.splice(withUsage.indexOf("[DONE]"), 0, USAGE);
  for (const event of withUsage) {
    res.write(`data: ${event === "[DONE]" ? "[DONE]" : JSON.stringify(event)}\n\n`);
  }
  res.end();
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
