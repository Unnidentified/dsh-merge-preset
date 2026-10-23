/**
 * Native DSH LLM adapters — no pi-ai.
 *
 * Serves hand-declared endpoints through DSH's own `LlmAdapter` seam:
 *   - `openai-chat`        OpenAI Chat Completions (Concentrate AI, RunInfra, …)
 *   - `anthropic-messages` Anthropic Messages (Merge Gateway, …)
 *
 * Everything here is DSH's own code plus global `fetch`; nothing imports pi-ai.
 *
 * Images are resolved through the harness attachment plane (`ctx.attachments`) and
 * sent as data-URL / base64 parts. A set over the route budget is trimmed oldest
 * first and the dropped occurrences degrade to the harness placeholder text, so an
 * oversized prompt never fails the turn.
 *
 * Wire knowledge was established by probing the live endpoints:
 *   Concentrate  POST {base}/chat/completions         SSE, usage.prompt_tokens_details.cached_tokens
 *   Merge        POST {base}/v1/messages?beta=true    Anthropic SSE, usage.cache_read_input_tokens
 *
 * @module dsh-llm-direct
 */
import z from "@deepseek-ai/schemastery";
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  fileHandleText,
  offloadedImageText,
  projectImagesForTextModel,
  resolveImageAttachmentAccess,
} from "@deepseek-ai/dsh-llm";

const PKG = "dsh-merge-preset";
const name = "merge-adapter";
const inject = ["llm"];

/** Harness reasoning levels, in ascending order. */
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Thinking-token budget per reasoning level, for Anthropic-shaped routes.
 *
 * Anthropic has no "effort" string: reasoning breadth is a token budget, and the
 * provider requires `max_tokens` to exceed it. These mirror the harness level names so
 * one profile describes both endpoint families.
 */
const THINKING_BUDGETS = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};

/** Smallest `max_tokens` headroom kept above a thinking budget. */
const THINKING_HEADROOM = 1024;
const MODALITIES = ["text", "image"];

/** level -> wire value (`null`/`""` means "send nothing"). */
const EffortMap = z.dict(z.union([z.string(), z.const(null)]), z.union(EFFORTS));

const ImageTarget = z.object({
  width: z.number().step(1).min(1).default(1568),
  height: z.number().step(1).min(1).default(1568),
  maxBytes: z.number().step(1).min(1).default(5_000_000),
});

const ImageBudget = z.object({
  maxImages: z.number().step(1).min(0).default(20),
  maxBytes: z.number().step(1).min(0).default(40_000_000),
});

const ModelConfig = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODALITIES)),
  reasoningEfforts: z.union([z.const(false), EffortMap]),
});

const ProviderConfig = z.object({
  displayName: z.string(),
  apiKeyEnv: z.string().required(),
  baseURL: z.string().required(),
  endpoint: z.union(["openai-chat", "anthropic-messages"]).required(),
  reasoning: z.union(EFFORTS),
  contextWindow: z.number().step(1).min(1).default(1048576),
  defaultMaxTokens: z.number().step(1).min(1).default(32768),
  defaultInput: z.array(z.union(MODALITIES)).default(["text"]),
  reasoningEfforts: z.union([z.const(false), EffortMap]),
  /** Anthropic only: attach `cache_control` to the system block and the last tool. */
  cacheControl: z.union(["none", "short", "long"]).default("none"),
  /**
   * OpenAI Chat Completions only: send `prompt_cache_retention` to extend the implicit
   * prompt cache's lifetime. `short` -> "in_memory", `long` -> "24h" (the only two values
   * Concentrate accepts; "5m"/"1h"/"30m" are rejected 400).
   *
   * On Concentrate this is also the routing control that matters: one model id is served
   * by nine providers, each with its OWN prompt cache, and only `deepseek` declares
   * `prompt_cache_retention` support. Sending the field therefore pins the request to
   * `deepseek` - a single stable cache namespace with a long TTL - instead of leaving
   * routing to Concentrate's chooser. Measured: without the field, requests landed on
   * `novita`; with it, they land on `deepseek`.
   */
  cacheRetention: z.union(["none", "short", "long"]).default("none"),
  imageTarget: ImageTarget,
  imageBudget: ImageBudget,
  models: z.array(ModelConfig).default([]),
});

const Config = z.object({ providers: z.dict(ProviderConfig).default({}) });

//#region helpers

/**
 * Retention level -> the `prompt_cache_retention` wire value.
 *
 * `undefined` means "send nothing" (implicit caching only), which is what `none` gives.
 * These are the only two values Concentrate accepts.
 */
const RETENTION_WIRE = { short: "in_memory", long: "24h" };

/** The `prompt_cache_retention` value for a provider, or undefined to omit the field. */
function retentionFor(provider) {
  const level = provider?.cacheRetention;
  return level === undefined || level === "none" ? undefined : RETENTION_WIRE[level];
}

/** The effective reasoning map for one model, falling back to the provider default. */
function effortMapOf(provider, model) {
  const raw = model?.reasoningEfforts ?? provider?.reasoningEfforts;
  if (raw === false || raw === null || raw === undefined) return undefined;
  const out = {};
  for (const [level, wire] of Object.entries(raw)) {
    if (!EFFORTS.includes(level)) continue;
    out[level] = wire === null || wire === "" ? null : String(wire);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The wire value for the selected level, or undefined when nothing should be sent. */
function wireFor(map, effortId) {
  if (map === undefined || effortId === undefined) return undefined;
  const wire = map[String(effortId)];
  return wire === null || wire === undefined ? undefined : wire;
}

/** TokenUsage with `inputTokens` = UNCACHED prompt tokens (the harness convention). */
function usageOf({ uncached, output, cacheRead, cacheWrite, reasoning }) {
  const read = cacheRead ?? 0;
  const write = cacheWrite ?? 0;
  const usage = {
    inputTokens: uncached,
    outputTokens: output,
    totalTokens: uncached + output + read + write,
  };
  if (read > 0) usage.cacheReadTokens = read;
  if (write > 0) usage.cacheWriteTokens = write;
  if (reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}

function finishFor(reason) {
  if (reason === "tool_calls" || reason === "tool_use") return { kind: "tool-calls" };
  if (reason === "length" || reason === "max_tokens") return { kind: "max-tokens" };
  return { kind: "stop" };
}

/**
 * Provider-neutral failure class for one HTTP status.
 *
 * 401 and 403 must not share a class. A 401 means the credential was rejected; a 403
 * means the credential was ACCEPTED but the request is not permitted - e.g. Concentrate
 * answering "Model is not allowed by the current settings". Borrowing `AUTH` for that
 * makes the harness UI print "API key is invalid" and drop the provider's message
 * (the UI blanks the text for `AUTH`), sending you after a key problem that is not
 * there. Any other class surfaces the provider message verbatim. None of these are in
 * the harness retry set, so a permission error is never retried.
 */
function errorCodeFor(status, message = "") {
  if (status === 401) return "AUTH";
  if (status === 403) {
    if (/model/i.test(message) && /not allowed|not permitted|no access|disabled/i.test(message)) {
      return "MODEL_NOT_ALLOWED";
    }
    return "PERMISSION_DENIED";
  }
  if (status === 402) return "QUOTA";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "SERVER";
  return "INVALID_REQUEST";
}

async function httpErrorFor(res) {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    /* body already gone */
  }
  let message = raw;
  try {
    const body = JSON.parse(raw);
    message = body?.error?.message ?? body?.message ?? raw;
  } catch {
    /* not JSON */
  }
  return new LlmError(
    `${PKG}: HTTP ${res.status}: ${String(message).slice(0, 800)}`,
    errorCodeFor(res.status, String(message)),
    { status: res.status },
  );
}

/** Yield logical SSE lines (`\n` or `\r\n`) from a fetch response body. */
async function* sseLines(res) {
  const body = res.body;
  if (body === null) throw new LlmError(`${PKG}: response carried no body`, "TRANSPORT");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line;
      }
    }
    if (buffer.length > 0) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/** Attachment id of one image block, or undefined when it carries none. */
function imageIdOf(block) {
  const id = block?.attachment?.attachmentId;
  return id === undefined ? undefined : String(id);
}

/**
 * Resolve every image occurrence of the request into a request-ready version.
 * @returns a Map of attachment id -> the attachment provider's request version.
 */
async function resolveImageVersions(messages, attachments, target, signal) {
  const versions = new Map();
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block?.type !== "image") continue;
      const id = imageIdOf(block);
      if (id === undefined || versions.has(id)) continue;
      versions.set(id, await attachments.readImageRequest(block.attachment, target, signal));
    }
  }
  return versions;
}

/**
 * Trim the oldest image occurrences until the route budget is met, replacing each
 * dropped occurrence with the harness placeholder text. The occurrences are counted
 * in one pass and dropped in another, both in the same message order, so the two
 * passes agree on which images are removed.
 */
function enforceImageBudget(messages, versions, budget, accessOf) {
  const encoded = [];
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block?.type !== "image" || block.offloaded === true) continue;
      const version = versions.get(imageIdOf(block));
      const bytes = version?.bytes ?? block.attachment?.bytes ?? 0;
      encoded.push(Math.ceil(bytes * (4 / 3))); // base64 growth
    }
  }
  let total = encoded.reduce((sum, bytes) => sum + bytes, 0);
  let excessCount = Math.max(0, encoded.length - budget.maxImages);
  let drop = 0;
  while (drop < encoded.length && (excessCount > 0 || total > budget.maxBytes)) {
    total -= encoded[drop];
    drop += 1;
    if (excessCount > 0) excessCount -= 1;
  }
  if (drop === 0) return messages;

  let seen = -1;
  return messages.map((message) => {
    let changed = false;
    const content = [];
    for (const block of message.content ?? []) {
      if (block?.type === "image" && block.offloaded !== true) {
        seen += 1;
        if (seen < drop) {
          content.push({ type: "text", text: offloadedImageText(block.attachment, accessOf?.(block.attachment)) });
          changed = true;
          continue;
        }
      }
      content.push(block);
    }
    return changed ? { ...message, content } : message;
  });
}

/** Render one content array for the OpenAI chat surface. */
function openaiContentOf(content, versions, accessOf) {
  const parts = [];
  let omitted = 0;
  for (const block of content ?? []) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text") {
      if (block.text.length > 0) parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "reasoning") continue;
    if (block.type === "image") {
      if (block.offloaded === true) {
        parts.push({ type: "text", text: offloadedImageText(block.attachment, accessOf?.(block.attachment)) });
        continue;
      }
      const version = versions.get(imageIdOf(block));
      if (version === undefined) {
        omitted += 1;
        continue;
      }
      parts.push({
        type: "image_url",
        image_url: { url: `data:${version.mediaType};base64,${toBase64(version.data)}` },
      });
      continue;
    }
    if (block.type === "file") {
      parts.push({ type: "text", text: fileHandleText(block.attachment) });
      continue;
    }
    omitted += 1;
  }
  if (omitted > 0) parts.push({ type: "text", text: `[${omitted} unsupported block(s) omitted by ${PKG}]` });
  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("");
  return parts;
}

/** OpenAI chat-completions message array from the harness request. */
function openaiMessages(options, versions, accessOf) {
  const out = [];
  if (typeof options.system === "string" && options.system.length > 0) {
    out.push({ role: "system", content: options.system });
  }
  for (const message of options.messages ?? []) {
    if (message.role === "system") {
      const text = openaiContentOf(message.content, versions, accessOf);
      if (typeof text === "string" && text.length > 0) out.push({ role: "system", content: text });
      continue;
    }
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: String(message.toolCallId ?? message.source?.callId ?? ""),
        content: openaiContentOf(message.content, versions, accessOf) || "(no output)",
      });
      continue;
    }
    if (message.role === "assistant") {
      const content = openaiContentOf(message.content, versions, accessOf);
      const entry = { role: "assistant", content: content === "" ? null : content };
      const calls = (message.content ?? []).filter((block) => block?.type === "tool-call");
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => ({
          id: String(call.id),
          type: "function",
          function: { name: call.name, arguments: call.arguments === "" ? "{}" : call.arguments },
        }));
      }
      out.push(entry);
      continue;
    }
    out.push({ role: "user", content: openaiContentOf(message.content, versions, accessOf) });
  }
  return out;
}

/** Render one content array as Anthropic blocks. */
function anthropicBlocks(content, versions, accessOf) {
  const blocks = [];
  let omitted = 0;
  for (const block of content ?? []) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text") {
      if (block.text.length > 0) blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "reasoning") continue;
    if (block.type === "tool-call") {
      let input = {};
      try {
        input = block.arguments ? JSON.parse(block.arguments) : {};
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_use", id: String(block.id), name: block.name, input });
      continue;
    }
    if (block.type === "image") {
      if (block.offloaded === true) {
        blocks.push({ type: "text", text: offloadedImageText(block.attachment, accessOf?.(block.attachment)) });
        continue;
      }
      const version = versions.get(imageIdOf(block));
      if (version === undefined) {
        omitted += 1;
        continue;
      }
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: version.mediaType, data: toBase64(version.data) },
      });
      continue;
    }
    if (block.type === "file") {
      blocks.push({ type: "text", text: fileHandleText(block.attachment) });
      continue;
    }
    omitted += 1;
  }
  if (omitted > 0) blocks.push({ type: "text", text: `[${omitted} unsupported block(s) omitted by ${PKG}]` });
  return blocks;
}

/** Anthropic Messages array: strict alternation, tool results grouped into one user turn. */
function anthropicMessages(options, versions, accessOf) {
  const out = [];
  const push = (role, blocks) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const message of options.messages ?? []) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const blocks = anthropicBlocks(message.content, versions, accessOf);
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const result = {
        type: "tool_result",
        tool_use_id: String(message.toolCallId ?? message.source?.callId ?? ""),
        content: text.length > 0 ? text : "(no output)",
      };
      if (message.isError === true) result.is_error = true;
      // Images in a tool result ride the same user turn, after the result block.
      push("user", [result, ...blocks.filter((block) => block.type === "image")]);
      continue;
    }
    if (message.role === "assistant") {
      const blocks = anthropicBlocks(message.content, versions, accessOf);
      push("assistant", blocks.length > 0 ? blocks : [{ type: "text", text: " " }]);
      continue;
    }
    const blocks = anthropicBlocks(message.content, versions, accessOf);
    push("user", blocks.length > 0 ? blocks : [{ type: "text", text: " " }]);
  }
  // Anthropic requires the first turn to be the user's.
  if (out.length > 0 && out[0].role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: " " }] });
  return out;
}

//#endregion

class DirectAdapter extends LlmAdapter {
  /**
   * @param ctx - plugin context (credentials + attachments services).
   * @param providers - resolved provider profiles, keyed by route id.
   */
  constructor(ctx, providers) {
    super();
    this.ctx = ctx;
    this.providers = providers;
  }

  providerInfo(provider) {
    const profile = this.providers.get(provider);
    return { id: provider, name: profile?.displayName ?? provider };
  }

  async listModels(provider) {
    const profile = this.providers.get(provider);
    if (profile === undefined) return [];
    return profile.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: model.inputModalities ?? profile.defaultInput ?? ["text"],
    }));
  }

  async resolveModel(provider, model) {
    const profile = this.providers.get(provider);
    const entry = profile?.models.find((candidate) => candidate.id === model);
    const info = {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry?.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry?.inputModalities ?? profile?.defaultInput ?? ["text"],
    };
    const contextWindow = entry?.contextWindow ?? profile?.contextWindow;
    if (contextWindow !== undefined) info.context = { contextWindow };
    const maxTokens = entry?.maxTokens ?? profile?.defaultMaxTokens;
    if (maxTokens !== undefined) info.defaultMaxTokens = maxTokens;
    const map = effortMapOf(profile, entry);
    if (map !== undefined) {
      const levels = Object.keys(map);
      if (levels.some((level) => level !== "off")) {
        const preferred = profile?.reasoning === undefined ? undefined : map[profile.reasoning];
        info.reasoning = {
          efforts: levels.map((level) => ({
            id: ReasoningEffortId(level),
            name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
          })),
          ...(preferred === undefined || preferred === null
            ? {}
            : { defaultEffort: ReasoningEffortId(profile.reasoning) }),
        };
      }
    }
    return info;
  }

  stream(options) {
    const profile = this.providers.get(options.provider);
    if (profile === undefined) {
      return (async function* unknownRoute() {
        throw new LlmError(`${PKG}: unknown provider route "${options.provider}"`, "INVALID_REQUEST");
      })();
    }
    return profile.endpoint === "anthropic-messages"
      ? this.anthropicStream(options, profile)
      : this.openaiStream(options, profile);
  }

  /** Resolve one route's API key through the harness credential plane, then the environment. */
  async apiKey(profile, provider) {
    const ref = profile.apiKeyEnv;
    const credentials = this.ctx.get("credentials");
    let hit;
    if (credentials !== undefined) {
      try {
        hit = (await credentials.resolve(ref))?.value;
      } catch {
        /* fall through to the environment */
      }
    }
    if (hit === undefined || hit.length === 0) hit = process.env[ref];
    if (hit === undefined || hit.length === 0) {
      throw new LlmError(
        `${PKG}: no credential for provider route "${provider}"; set ${ref} on the Models page or export it`,
        "INVALID_CREDENTIAL",
      );
    }
    return assertUsableApiKey(hit, PKG, ref);
  }

  /**
   * Prepare the request's messages for one route: text-only models get image
   * placeholders, image-capable models get resolved request versions, and a set over
   * the route budget is trimmed oldest first.
   * @returns `{messages, versions, accessOf}` ready for serialization.
   */
  async prepareMessages(options, profile, model) {
    const attachments = this.ctx.get("attachments");
    const fs = this.ctx.get("fs");
    const accessOf = (ref) => {
      if (attachments === undefined || typeof fs?.processPathFromHostPath !== "function") return undefined;
      try {
        return resolveImageAttachmentAccess(attachments, (path) => fs.processPathFromHostPath(path), ref);
      } catch {
        return undefined;
      }
    };
    const messages = options.messages ?? [];
    if (!messages.some((message) => contentHasImage(message.content ?? []))) {
      return { messages, versions: new Map(), accessOf };
    }
    const accepts = (model?.inputModalities ?? profile.defaultInput ?? ["text"]).includes("image");
    if (!accepts) {
      return { messages: projectImagesForTextModel(messages), versions: new Map(), accessOf };
    }
    if (attachments === undefined || typeof attachments.readImageRequest !== "function") {
      throw new LlmError(
        `${PKG}: this composition mounts no attachment service, so image input cannot be resolved`,
        "UNSUPPORTED_CONTENT",
      );
    }
    const target = {
      width: profile.imageTarget?.width ?? 1568,
      height: profile.imageTarget?.height ?? 1568,
      maxBytes: profile.imageTarget?.maxBytes ?? 5_000_000,
    };
    const versions = await resolveImageVersions(messages, attachments, target, options.signal);
    const budget = {
      maxImages: profile.imageBudget?.maxImages ?? 20,
      maxBytes: profile.imageBudget?.maxBytes ?? 40_000_000,
    };
    return { messages: enforceImageBudget(messages, versions, budget, accessOf), versions, accessOf };
  }

  async postJSON(url, key, body, signal, extraHeaders) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
          ...attributionHeaders(),
          ...(extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw new LlmError(`${PKG}: request aborted by caller`, "ABORTED", { cause: error });
      throw new LlmError(`${PKG}: transport failure: ${String(error?.message ?? error)}`, "TRANSPORT", { cause: error });
    }
    if (!res.ok) throw await httpErrorFor(res);
    return res;
  }

  /** OpenAI Chat Completions, streamed. */
  async *openaiStream(options, profile) {
    const key = await this.apiKey(profile, options.provider);
    const entry = profile.models.find((candidate) => candidate.id === options.model);
    const wire = wireFor(effortMapOf(profile, entry), options.reasoningEffort);
    const prepared = await this.prepareMessages(options, profile, entry);
    const body = {
      model: options.model,
      messages: openaiMessages({ ...options, messages: prepared.messages }, prepared.versions, prepared.accessOf),
      stream: true,
      stream_options: { include_usage: true },
      ...(retentionFor(profile) === undefined
        ? {}
        : { prompt_cache_retention: retentionFor(profile) }),
      ...(options.maxTokens === undefined ? {} : { max_completion_tokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop }),
      ...(wire === undefined ? {} : { reasoning_effort: wire }),
      ...(options.tools === undefined || options.tools.length === 0
        ? {}
        : {
            tools: options.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
          }),
    };
    const url = `${String(profile.baseURL).replace(/\/+$/, "")}/chat/completions`;
    const res = await this.postJSON(url, key, body, options.signal);

    let nextIndex = 0;
    let textIndex = -1;
    let text = "";
    let reasoningIndex = -1;
    let reasoning = "";
    const calls = new Map();
    let stopReason;
    let usage;

    for await (const line of sseLines(res)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      if (payload.length === 0) continue;
      let frame;
      try {
        frame = JSON.parse(payload);
      } catch {
        continue;
      }
      if (frame.usage !== null && typeof frame.usage === "object") usage = frame.usage;
      const choice = frame.choices?.[0];
      if (choice === undefined) continue;
      const delta = choice.delta ?? {};

      const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
        if (reasoningIndex < 0) {
          reasoningIndex = nextIndex++;
          yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
        }
        reasoning += reasoningDelta;
        yield { type: "reasoning-delta", index: reasoningIndex, text: reasoningDelta };
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (textIndex < 0) {
          textIndex = nextIndex++;
          yield { type: "block-start", index: textIndex, blockType: "text" };
        }
        text += delta.content;
        yield { type: "text-delta", index: textIndex, text: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        const slotKey = call.index ?? 0;
        let slot = calls.get(slotKey);
        if (slot === undefined) {
          slot = { index: nextIndex++, id: call.id ?? "", name: call.function?.name ?? "", args: "" };
          calls.set(slotKey, slot);
          yield { type: "block-start", index: slot.index, blockType: "tool-call" };
        }
        if (typeof call.id === "string" && call.id.length > 0) slot.id = call.id;
        if (typeof call.function?.name === "string" && call.function.name.length > 0) {
          slot.name = call.function.name;
        }
        const argsDelta = call.function?.arguments ?? "";
        if (argsDelta.length > 0) {
          slot.args += argsDelta;
          yield {
            type: "tool-call-delta",
            index: slot.index,
            id: slot.id,
            ...(slot.name.length > 0 ? { name: slot.name } : {}),
            argumentsDelta: argsDelta,
          };
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
        stopReason = choice.finish_reason;
      }
    }

    // Close every open block, lowest index first, as the invariant requires.
    const ordered = [];
    if (reasoningIndex >= 0) ordered.push({ index: reasoningIndex, block: { type: "reasoning", text: reasoning } });
    if (textIndex >= 0) ordered.push({ index: textIndex, block: { type: "text", text } });
    for (const slot of calls.values()) {
      ordered.push({
        index: slot.index,
        block: { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.args === "" ? "{}" : slot.args },
      });
    }
    ordered.sort((a, b) => a.index - b.index);
    for (const item of ordered) yield { type: "block-end", index: item.index, block: item.block };

    const prompt = usage?.prompt_tokens ?? 0;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    yield {
      type: "usage",
      usage: usageOf({
        uncached: Math.max(0, prompt - cached),
        output: usage?.completion_tokens ?? 0,
        cacheRead: cached,
        cacheWrite: 0,
        reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      }),
    };
    yield { type: "finish", reason: finishFor(stopReason) };
  }

  /** Anthropic Messages, streamed. */
  async *anthropicStream(options, profile) {
    const key = await this.apiKey(profile, options.provider);
    const entry = profile.models.find((candidate) => candidate.id === options.model);
    const prepared = await this.prepareMessages(options, profile, entry);
    const cacheControl =
      profile.cacheControl === "long"
        ? { type: "ephemeral", ttl: "1h" }
        : profile.cacheControl === "short"
          ? { type: "ephemeral" }
          : undefined;
    const systemText = typeof options.system === "string" ? options.system : "";
    // Anthropic expresses reasoning as a token budget, so the selected harness level
    // becomes one. `max_tokens` must exceed the budget, so the ceiling is raised only
    // when the caller's own cap is too small to hold the level at all.
    const level = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort);
    const wantedBudget = level === undefined || level === "off" ? undefined : THINKING_BUDGETS[level];
    let maxTokens = options.maxTokens ?? profile.defaultMaxTokens ?? 4096;
    let thinkingBudget;
    if (wantedBudget !== undefined && wantedBudget + THINKING_HEADROOM <= Math.max(maxTokens, wantedBudget + THINKING_HEADROOM)) {
      thinkingBudget = wantedBudget;
      maxTokens = Math.max(maxTokens, wantedBudget + THINKING_HEADROOM);
    }
    const body = {
      model: options.model,
      max_tokens: maxTokens,
      ...(thinkingBudget === undefined ? {} : { thinking: { type: "enabled", budget_tokens: thinkingBudget } }),
      messages: anthropicMessages({ ...options, messages: prepared.messages }, prepared.versions, prepared.accessOf),
      stream: true,
      ...(systemText.length === 0
        ? {}
        : {
            system: [
              {
                type: "text",
                text: systemText,
                ...(cacheControl === undefined ? {} : { cache_control: cacheControl }),
              },
            ],
          }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop_sequences: options.stop }),
      ...(options.tools === undefined || options.tools.length === 0
        ? {}
        : {
            tools: options.tools.map((tool, index, all) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
              ...(cacheControl === undefined || index !== all.length - 1 ? {} : { cache_control: cacheControl }),
            })),
          }),
    };
    const url = `${String(profile.baseURL).replace(/\/+$/, "")}/v1/messages?beta=true`;
    const res = await this.postJSON(url, key, body, options.signal, { "anthropic-version": "2023-06-01" });

    const open = new Map();
    let stopReason;
    let uncached = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let output = 0;

    const close = (index) => {
      const slot = open.get(index);
      if (slot === undefined) return undefined;
      open.delete(index);
      if (slot.kind === "text") return { index, block: { type: "text", text: slot.accum } };
      if (slot.kind === "reasoning") return { index, block: { type: "reasoning", text: slot.accum } };
      return {
        index,
        block: { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.accum === "" ? "{}" : slot.accum },
      };
    };

    for await (const line of sseLines(res)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      switch (event.type) {
        case "message_start": {
          const u = event.message?.usage ?? {};
          uncached = u.input_tokens ?? 0;
          cacheRead = u.cache_read_input_tokens ?? 0;
          cacheWrite = u.cache_creation_input_tokens ?? 0;
          output = u.output_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const index = event.index ?? 0;
          const block = event.content_block ?? {};
          if (block.type === "text") {
            open.set(index, { kind: "text", accum: "" });
            yield { type: "block-start", index, blockType: "text" };
          } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            open.set(index, { kind: "reasoning", accum: "" });
            yield { type: "block-start", index, blockType: "reasoning" };
          } else if (block.type === "tool_use") {
            open.set(index, { kind: "tool-call", id: String(block.id ?? ""), name: String(block.name ?? ""), accum: "" });
            yield { type: "block-start", index, blockType: "tool-call" };
          }
          break;
        }
        case "content_block_delta": {
          const index = event.index ?? 0;
          const slot = open.get(index);
          if (slot === undefined) break;
          const delta = event.delta ?? {};
          if (delta.type === "text_delta" && slot.kind === "text") {
            slot.accum += delta.text ?? "";
            yield { type: "text-delta", index, text: delta.text ?? "" };
          } else if (delta.type === "thinking_delta" && slot.kind === "reasoning") {
            slot.accum += delta.thinking ?? "";
            yield { type: "reasoning-delta", index, text: delta.thinking ?? "" };
          } else if (delta.type === "input_json_delta" && slot.kind === "tool-call") {
            const partial = delta.partial_json ?? "";
            slot.accum += partial;
            if (partial.length > 0) {
              yield {
                type: "tool-call-delta",
                index,
                id: slot.id,
                ...(slot.name.length > 0 ? { name: slot.name } : {}),
                argumentsDelta: partial,
              };
            }
          }
          break;
        }
        case "content_block_stop": {
          const closed = close(event.index ?? 0);
          if (closed !== undefined) yield { type: "block-end", index: closed.index, block: closed.block };
          break;
        }
        case "message_delta": {
          // Merge Gateway reports the authoritative prompt-side counts here (its
          // `message_start` frame carries zeros), so take every field that is present.
          const u = event.usage ?? {};
          if (u.input_tokens !== undefined) uncached = u.input_tokens;
          if (u.cache_read_input_tokens !== undefined) cacheRead = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens !== undefined) cacheWrite = u.cache_creation_input_tokens;
          if (u.output_tokens !== undefined) output = u.output_tokens;
          if (typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason;
          break;
        }
        case "error":
          throw new LlmError(
            `${PKG}: provider stream error: ${event.error?.message ?? "unknown"}`,
            errorCodeFor(Number(event.error?.status ?? 500)),
          );
        default:
          break;
      }
    }

    for (const index of [...open.keys()].sort((a, b) => a - b)) {
      const closed = close(index);
      if (closed !== undefined) yield { type: "block-end", index: closed.index, block: closed.block };
    }
    yield { type: "usage", usage: usageOf({ uncached, output, cacheRead, cacheWrite, reasoning: 0 }) };
    yield { type: "finish", reason: finishFor(stopReason) };
  }
}

function apply(ctx, config) {
  const providers = new Map();
  for (const [id, raw] of Object.entries(config?.providers ?? {})) {
    providers.set(id, { ...raw, models: raw.models ?? [] });
  }
  if (providers.size === 0) return;
  ctx.llm.registerAdapter([...providers.keys()], new DirectAdapter(ctx, providers));
}

export { Config, apply, inject, name };
