import * as v from 'valibot';

// Bumped on any breaking change to the server or local protocol.
export const PROTOCOL = 1;

// Control and invisible formatting characters (Unicode Cc, Cf, Zl, Zp: escapes, bidi
// overrides and isolates, zero-width and direction marks, soft hyphens, line separators)
// can rewrite a terminal or disguise text in the drawer.
export const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
export const NoControl = v.regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u);
// Chat also keeps newlines, tabs, and the zero-width (non-)joiners that emoji sequences
// and scripts like Persian and Hindi need.
export const NoControlText = v.regex(/^(?:[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[\t\n\u200c\u200d])*$/u);

// Lowercased GitHub login.
export const Handle = v.pipe(v.string(), v.regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/));
export type Handle = v.InferOutput<typeof Handle>;

// Display name from GitHub, shown next to the handle.
export const Name = v.pipe(v.string(), v.minLength(1), v.maxLength(64), NoControl);

export const Tool = v.picklist([
  'claude-code',
  'codex',
  'opencode',
  'gemini-cli',
  'qwen-code',
  'factory',
  'codebuddy',
  'qoder',
  'kimi-cli',
  'cursor',
  'ollama',
  'lm-studio',
  'shell',
]);
export type Tool = v.InferOutput<typeof Tool>;

export const Model = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._:/@-]{1,80}$/));

// "owner/name" of a public GitHub repo.
export const Repo = v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/));

export const Timestamp = v.pipe(v.number(), v.integer(), v.minValue(0));
export const Count = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);

export const Status = v.picklist(['online', 'idle', 'offline']);
export type Status = v.InferOutput<typeof Status>;

export const PublicProject = v.variant('visibility', [
  v.object({ visibility: v.literal('private') }),
  v.object({ visibility: v.literal('public'), repo: Repo }),
]);

// The only shape of activity that may leave the machine. Every field is optional
// because the user can turn each one off.
export const PublicActivity = v.object({
  // A tool added in a later version is dropped rather than failing the whole presence.
  tool: v.optional(v.fallback(v.optional(Tool), undefined)),
  model: v.optional(Model),
  project: v.optional(PublicProject),
  // Session start, rounded down to the minute.
  since: v.optional(Timestamp),
});
export type PublicActivity = v.InferOutput<typeof PublicActivity>;

export const PublicPresence = v.object({
  status: Status,
  activity: v.optional(PublicActivity),
  // All-time input + output + cache-write tokens across connected tools.
  tokens: v.optional(Count),
  at: Timestamp,
});
export type PublicPresence = v.InferOutput<typeof PublicPresence>;

export const Ciphertext = v.object({
  type: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)),
  body: v.pipe(v.string(), v.base64(), v.maxLength(65_536)),
});
export type Ciphertext = v.InferOutput<typeof Ciphertext>;

export const MessageId = v.pipe(v.string(), v.uuid());
