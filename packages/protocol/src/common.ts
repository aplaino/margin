import * as v from 'valibot';

// Bumped on any breaking change to the server or local protocol.
export const PROTOCOL = 1;

// Control and invisible formatting characters (Unicode Cc, Cf, Zl, Zp: escapes, bidi
// overrides and isolates, zero-width and direction marks, soft hyphens, line separators)
// can rewrite a terminal or disguise text in the drawer.
export const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// A nudge travels as an ordinary encrypted message with this text: two invisible separators
// (format characters, which no typed message may contain) and a wave. A Margin that doesn't
// know nudges strips the separators and shows the wave.
export const NUDGE = '⁣⁣👋';
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
  'kimi-code',
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

// Recent totals, worked out on the sender's Mac by its local day. Each group follows its
// sharing switch: tokens (today, week, daily), prompts, time (minutes, days, sessions,
// longest), tool and model.
export const PublicStats = v.object({
  today: v.optional(Count),
  week: v.optional(Count),
  // Tokens on each of the last 14 days, oldest first.
  daily: v.optional(v.pipe(v.array(Count), v.maxLength(14))),
  // Minutes in a tool, not idle, over the last 7 days.
  minutes: v.optional(Count),
  // Days with any tool use among the last 14.
  days: v.optional(v.pipe(Count, v.maxValue(14))),
  // Prompts sent to coding tools: today, over the last 7 days, and since counting began.
  promptsToday: v.optional(Count),
  promptsWeek: v.optional(Count),
  prompts: v.optional(Count),
  // Coding sessions started over the last 7 days, and the longest one's minutes in a tool.
  sessions: v.optional(Count),
  longest: v.optional(Count),
  // The tool and model with the most time over the last 7 days.
  tool: v.optional(v.fallback(v.optional(Tool), undefined)),
  model: v.optional(Model),
});
export type PublicStats = v.InferOutput<typeof PublicStats>;

export const PublicPresence = v.object({
  status: Status,
  activity: v.optional(PublicActivity),
  // All-time input + output + cache-write tokens across connected tools.
  tokens: v.optional(Count),
  stats: v.optional(PublicStats),
  at: Timestamp,
});
export type PublicPresence = v.InferOutput<typeof PublicPresence>;

export const Ciphertext = v.object({
  type: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)),
  body: v.pipe(v.string(), v.base64(), v.maxLength(65_536)),
});
export type Ciphertext = v.InferOutput<typeof Ciphertext>;

export const MessageId = v.pipe(v.string(), v.uuid());

// A link's preview, fetched on the sender's Mac and sent encrypted after the message, so the
// receiving Mac never contacts the site. Its address must appear in the message's text.
export const LinkPreview = v.object({
  url: v.pipe(v.string(), v.maxLength(2048), v.url(), v.startsWith('https://')),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(200), NoControl),
  detail: v.optional(v.pipe(v.string(), v.maxLength(300), NoControl)),
  site: v.optional(v.pipe(v.string(), v.maxLength(80), NoControl)),
  // A small JPEG, base64; it has to fit in one encrypted control.
  image: v.optional(v.pipe(v.string(), v.base64(), v.maxLength(24_000))),
});
export type LinkPreview = v.InferOutput<typeof LinkPreview>;
