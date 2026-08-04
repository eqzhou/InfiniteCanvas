export type CodexTranscriptEvent = {
  sequence?: number;
  type: string;
  method?: string;
  id?: unknown;
  params?: unknown;
  data?: unknown;
};

export type CodexTranscriptMessage = {
  id?: string;
  role: "user" | "assistant";
  text: string;
};

export type CodexTranscriptState = {
  messages: CodexTranscriptMessage[];
  seenEventKeys: string[];
};

const MAX_MESSAGES = 120;
const MAX_SEEN_EVENT_KEYS = 4_096;
const MAX_EVENT_JSON_CHARS = 256 * 1024;
const MAX_MESSAGE_TEXT_CHARS = 100_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonKey(value: unknown): string {
  try {
    const serialized = JSON.stringify(value) ?? "";
    return serialized.length <= MAX_EVENT_JSON_CHARS ? serialized : "";
  } catch {
    return "";
  }
}

function validEvent(value: unknown): value is CodexTranscriptEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<CodexTranscriptEvent>;
  if (typeof event.type !== "string" || !event.type || event.type.length > 64) return false;
  if (event.method !== undefined && (typeof event.method !== "string" || event.method.length > 128)) return false;
  if (event.sequence !== undefined &&
      (typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence) || event.sequence < 0)) return false;
  return jsonKey(value) !== "";
}

function eventKey(event: CodexTranscriptEvent): string {
  if (typeof event.sequence === "number" && Number.isSafeInteger(event.sequence) && event.sequence >= 0) {
    return `sequence:${event.sequence}`;
  }
  return [
    "payload",
    event.type,
    event.method ?? "",
    jsonKey(event.id),
    jsonKey(event.params),
    jsonKey(event.data),
  ].join(":");
}

function boundedMessages(messages: readonly CodexTranscriptMessage[]): CodexTranscriptMessage[] {
  return messages
    .filter((message): message is CodexTranscriptMessage => Boolean(message) &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.text === "string" && message.text !== "")
    .map((message) => ({
      ...(typeof message.id === "string" && message.id.length <= 128 ? { id: message.id } : {}),
      role: message.role,
      text: message.text.slice(0, MAX_MESSAGE_TEXT_CHARS),
    }))
    .slice(-MAX_MESSAGES);
}

function boundedEventKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.filter(Boolean))].slice(-MAX_SEEN_EVENT_KEYS);
}

function userMessage(event: CodexTranscriptEvent): { id: string; text: string } | undefined {
  if (event.method !== "openboard/user_message") return undefined;
  const data = record(event.data);
  if (typeof data?.id !== "string" || !data.id || data.id.length > 128 ||
      typeof data.text !== "string" || !data.text || data.text.length > MAX_MESSAGE_TEXT_CHARS) return undefined;
  return { id: data.id, text: data.text };
}

function assistantDelta(event: CodexTranscriptEvent): { id?: string; text: string } | undefined {
  const method = event.method ?? "";
  if (!method.includes("agent_message") && !method.includes("agent/message") && !method.includes("message")) {
    return undefined;
  }
  const params = record(event.params);
  const text = typeof params?.delta === "string" ? params.delta
    : typeof params?.text === "string" ? params.text
      : "";
  if (!text || text.length > MAX_MESSAGE_TEXT_CHARS) return undefined;
  const item = record(params?.item);
  const message = record(params?.message);
  const id = [params?.messageId, params?.itemId, item?.id, message?.id]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return { ...(id ? { id } : {}), text };
}

function upsertUserMessage(
  messages: readonly CodexTranscriptMessage[],
  incoming: { id: string; text: string },
): CodexTranscriptMessage[] {
  const index = messages.findIndex((message) => message.role === "user" && message.id === incoming.id);
  if (index < 0) return boundedMessages([...messages, { id: incoming.id, role: "user", text: incoming.text }]);
  return messages.map((message, messageIndex) => messageIndex === index
    ? { ...message, text: incoming.text }
    : { ...message });
}

function appendAssistantDelta(
  messages: readonly CodexTranscriptMessage[],
  incoming: { id?: string; text: string },
): CodexTranscriptMessage[] {
  const index = incoming.id
    ? messages.findIndex((message) => message.role === "assistant" && message.id === incoming.id)
    : -1;
  if (index >= 0) {
    return messages.map((message, messageIndex) => messageIndex === index
      ? { ...message, text: `${message.text}${incoming.text}`.slice(0, MAX_MESSAGE_TEXT_CHARS) }
      : { ...message });
  }
  const last = messages[messages.length - 1];
  if (!incoming.id && last?.role === "assistant") {
    return [...messages.slice(0, -1), {
      ...last,
      text: `${last.text}${incoming.text}`.slice(0, MAX_MESSAGE_TEXT_CHARS),
    }];
  }
  return boundedMessages([...messages, {
    ...(incoming.id ? { id: incoming.id } : {}),
    role: "assistant",
    text: incoming.text.slice(0, MAX_MESSAGE_TEXT_CHARS),
  }]);
}

function mergeTranscriptMessages(
  history: readonly CodexTranscriptMessage[],
  live: readonly CodexTranscriptMessage[],
): CodexTranscriptMessage[] {
  let merged = history.map((message) => ({ ...message }));
  const consumed = new Set<number>();
  for (const current of live) {
    let index = current.id
      ? merged.findIndex((message, messageIndex) => !consumed.has(messageIndex) &&
        message.role === current.role && message.id === current.id)
      : -1;
    if (index < 0) {
      index = merged.findIndex((message, messageIndex) => !consumed.has(messageIndex) &&
        message.role === current.role && message.text === current.text);
    }
    if (index < 0 && current.role === "assistant") {
      const candidates = merged
        .map((message, messageIndex) => ({ message, messageIndex }))
        .filter(({ message, messageIndex }) => !consumed.has(messageIndex) &&
          message.role === "assistant" && message.text && current.text.startsWith(message.text));
      index = candidates.sort((left, right) => right.message.text.length - left.message.text.length)[0]?.messageIndex ?? -1;
    }
    if (index >= 0) {
      consumed.add(index);
      const prior = merged[index];
      const text = current.role === "assistant" && current.text.length < prior.text.length
        ? prior.text
        : current.text;
      merged = merged.map((message, messageIndex) => messageIndex === index
        ? { ...message, ...(current.id ? { id: current.id } : {}), text }
        : { ...message });
      continue;
    }
    merged = [...merged, { ...current }];
    consumed.add(merged.length - 1);
  }
  return boundedMessages(merged);
}

export function hydrateCodexTranscript(
  messages: readonly CodexTranscriptMessage[],
  events: readonly CodexTranscriptEvent[],
): CodexTranscriptState {
  return {
    messages: boundedMessages(messages),
    seenEventKeys: boundedEventKeys(events.filter(validEvent).map(eventKey)),
  };
}

export function mergeCodexTranscript(
  state: CodexTranscriptState,
  historyMessages: readonly CodexTranscriptMessage[],
  historyEvents: readonly CodexTranscriptEvent[],
): CodexTranscriptState {
  const history = hydrateCodexTranscript(historyMessages, historyEvents);
  return {
    messages: mergeTranscriptMessages(history.messages, state.messages),
    seenEventKeys: boundedEventKeys([...history.seenEventKeys, ...state.seenEventKeys]),
  };
}

export function applyCodexTranscriptEvent(
  state: CodexTranscriptState,
  event: CodexTranscriptEvent,
): CodexTranscriptState {
  if (!validEvent(event)) return state;
  const key = eventKey(event);
  if (state.seenEventKeys.includes(key)) return state;
  const seenEventKeys = boundedEventKeys([...state.seenEventKeys, key]);
  const incomingUser = userMessage(event);
  if (incomingUser) {
    return { messages: upsertUserMessage(state.messages, incomingUser), seenEventKeys };
  }
  const incomingAssistant = assistantDelta(event);
  if (incomingAssistant) {
    return { messages: appendAssistantDelta(state.messages, incomingAssistant), seenEventKeys };
  }
  return { messages: state.messages, seenEventKeys };
}

export function addCodexUserMessage(
  state: CodexTranscriptState,
  message: { id: string; text: string },
): CodexTranscriptState {
  return applyCodexTranscriptEvent(state, {
    type: "notification",
    method: "openboard/user_message",
    data: message,
  });
}
