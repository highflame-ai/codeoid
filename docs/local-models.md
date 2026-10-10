# Local models with llama.cpp

codeoid can run sessions on an open-weight model served on your own machine by llama.cpp's `llama-server`.
Nothing leaves the machine except what your MCP servers send, and there is no per-token cost.

codeoid does not bundle or start llama.cpp.
You run `llama-server` yourself, and the `llamacpp` backend talks to it over its OpenAI-compatible API.

## 1. Start llama-server

Install llama.cpp (`brew install llama.cpp`, or build it with CUDA or Metal for a GPU), then start the server with a GGUF model:

```bash
llama-server -m /path/to/model.gguf --host 127.0.0.1 --port 8080 \
  -ngl 99 --jinja -c 32768
```

| Flag | Why |
|---|---|
| `-ngl 99` | Offload all layers to the GPU. Drop it for CPU-only, which is much slower on long prompts. |
| `--jinja` | Use the model's own chat template, which tool calls need. Without it, tool-using turns can fail. |
| `-c 32768` | Context size. llama-server's default is 4096 tokens, which is too small for an agent's system prompt plus a real conversation. Use as much as the model and your memory allow. |

With several parallel slots (`--parallel`), each request gets its share of `-c`, not all of it.
codeoid reads the per-request size from the server, so you do not need to work it out.

Check that the server is up:

```bash
curl http://127.0.0.1:8080/health
```

## 2. Enable the backend

Add this to `~/.codeoid/config.json` and restart the daemon:

```json
{
  "providers": {
    "llamacpp": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:8080/v1"
    }
  }
}
```

Then create a session on it:

```bash
codeoid new local-test . --provider llamacpp
```

Or make it the default backend with `"session": { "defaultProvider": "llamacpp" }`.

The backend is off by default.
The daemon cannot tell at startup whether a server is listening, and advertising a backend that fails on first use is worse than asking you to switch it on.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Register the `llamacpp` backend. |
| `baseUrl` | `http://127.0.0.1:8080/v1` | llama-server's OpenAI-compatible endpoint. |
| `apiKey` | `sk-local` | Only checked if you started llama-server with `--api-key`. |
| `model` | — | Cosmetic. llama-server serves the GGUF it was launched with, whatever the request names. |
| `mcpServers` | `[]` | External MCP servers whose tools this backend is offered. See below. |

`llamacpp` is a separate backend from `openai`, so a local server and a cloud OpenAI-compatible gateway can be enabled side by side.

## Context size

codeoid asks llama-server for its context size after every turn and uses that number everywhere it matters: the context meter, auto-rotate, and how much history it carries over when you switch a session to this backend or fork onto it.

Before the first turn it has not asked yet, so it assumes llama-server's default of 4096 tokens.
A session switched onto the local backend may therefore carry over less history on that first turn than the server could hold; from the second turn on, the real size is used.

If a request does not fit, the turn fails with the server's own message, for example `request (42638 tokens) exceeds the available context size (32768 tokens)`.
Start the server with a larger `-c`, or offer fewer MCP tools (next section).

## MCP tools

Every MCP tool a backend is offered has its definition sent with every request.
A cloud model can afford that; a local one usually cannot.
In testing, six ordinary MCP servers came to about 42,000 tokens of tool definitions — more than a 32k model can hold before the conversation starts.

So the local backend is offered **no external MCP servers by default**.
Name the ones you want:

```json
{
  "providers": {
    "llamacpp": {
      "enabled": true,
      "mcpServers": ["github"]
    }
  }
}
```

codeoid's own memory tools (recall across past sessions) are always offered; they are small.

Some MCP servers describe a parameter as "any value" in a form llama.cpp's grammar compiler rejects.
codeoid rewrites those schemas into an equivalent form llama.cpp accepts, so you do not need to change the server.

## Choosing a model

Agent work needs a model that follows tool-calling formats reliably.
Instruction-tuned models with native tool support, such as the Qwen 2.5 / Qwen 3 instruct families, work well.
Base models and very small models will chat but rarely use tools correctly.

Larger contexts cost memory: the KV cache grows with `-c`.
If the server fails to start or slows sharply, lower `-c` or use a smaller quantization.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Backend missing from the provider list | `providers.llamacpp.enabled` is not `true`, or the daemon was not restarted. |
| `Connection error` | Nothing is listening at `baseUrl`. Check `curl <host>/health`. |
| `exceeds the available context size` | The prompt does not fit. Raise `-c`, or remove servers from `mcpServers`. |
| "ended the response before sending anything" | An older llama-server reporting an error codeoid cannot read — usually the same context overflow. |
| Tool calls fail or come back as plain text | Start the server with `--jinja`, and use a model with tool-calling support. |
| Very slow first response | The server is running on the CPU. Check its startup log for a GPU device and use `-ngl 99`. |
| Port 8080 already in use | Start llama-server on another port and set `baseUrl` to match. |
