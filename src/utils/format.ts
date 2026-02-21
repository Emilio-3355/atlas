// WhatsApp message formatting (max 4096 chars per message)
const MAX_WHATSAPP_LENGTH = 4096;

export function formatForWhatsApp(text: string): string[] {
  // Convert markdown to WhatsApp formatting
  let formatted = text
    .replace(/\*\*(.*?)\*\*/g, '*$1*')          // **bold** → *bold*
    .replace(/__(.*?)__/g, '_$1_')               // __italic__ → _italic_
    .replace(/~~(.*?)~~/g, '~$1~')               // ~~strike~~ → ~strike~
    .replace(/`([^`]+)`/g, '```$1```')           // `code` → ```code```
    .replace(/^### (.*)/gm, '*$1*')              // ### heading → *heading*
    .replace(/^## (.*)/gm, '*$1*')               // ## heading → *heading*
    .replace(/^# (.*)/gm, '*$1*')                // # heading → *heading*
    .replace(/^\- /gm, '• ');                    // - item → • item

  // Split into chunks if too long
  if (formatted.length <= MAX_WHATSAPP_LENGTH) {
    return [formatted];
  }

  const chunks: string[] = [];
  let remaining = formatted;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_WHATSAPP_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (double newline, then single newline, then space)
    let splitAt = remaining.lastIndexOf('\n\n', MAX_WHATSAPP_LENGTH);
    if (splitAt < MAX_WHATSAPP_LENGTH / 2) {
      splitAt = remaining.lastIndexOf('\n', MAX_WHATSAPP_LENGTH);
    }
    if (splitAt < MAX_WHATSAPP_LENGTH / 2) {
      splitAt = remaining.lastIndexOf(' ', MAX_WHATSAPP_LENGTH);
    }
    if (splitAt < MAX_WHATSAPP_LENGTH / 2) {
      splitAt = MAX_WHATSAPP_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export function formatApprovalButtons(previewText: string, actionId: string): string {
  return `${previewText}\n\n_Reply:_\n*1* — Approve ✓\n*2* — Edit ✏️\n*3* — Cancel ✗\n\n_Action ID: ${actionId.slice(0, 8)}_`;
}

export function formatPlayByPlay(step: string, current: number, total: number): string {
  const progress = '▓'.repeat(current) + '░'.repeat(total - current);
  return `[${progress}] Step ${current}/${total}\n${step}`;
}
