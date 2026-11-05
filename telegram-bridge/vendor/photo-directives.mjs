// Portable parser functions extracted unchanged from https://github.com/woosungchoi/codex-telegram-bot/blob/c4c602834dc5170e119c63b9bb3c1a9f32a2c0d7/src/telegram/attachments.js
// MIT license; see LICENSE-woosungchoi.txt. Linux filesystem code is not included.
export function parseTelegramPhotoDirective(line) {
  const match = String(line ?? "").match(/^\s*\[\[telegram_photo:(.+)\]\]\s*$/);
  if (!match) return undefined;

  const [rawPath, rawCaption] = splitCaption(match[1]);
  return {
    path: rawPath.trim(),
    caption: normalizeCaption(rawCaption)
  };
}

export function parseStandaloneMarkdownImage(line) {
  const match = String(line ?? "").match(/^\s*!\[([^\]\n]*)\]\((\/[^)\n]+)\)\s*$/);
  if (!match) return undefined;

  return {
    path: match[2].trim(),
    caption: normalizeCaption(match[1])
  };
}

function splitCaption(value) {
  const marker = "|caption=";
  const index = value.indexOf(marker);
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + marker.length)];
}

function normalizeCaption(value) {
  const caption = String(value ?? "").trim();
  return caption ? caption.slice(0, 1024) : undefined;
}


