// The text a classifier sees for one event. The Python trainer builds the identical string (student/features.py).
const MEDIA = new Set(['image', 'video', 'audio', 'document']);
// Message types the WhatsApp connector does not know arrive as "other:<type>". These carry nothing to read (key exchange,
// history markers, votes on a poll, the header of an album whose pictures arrive as their own messages).
const EMPTY_OTHER = new Set(['senderKeyDistributionMessage', 'messageHistoryNotice', 'messageHistoryBundle', 'placeholderMessage', 'secretEncryptedMessage', 'pollUpdateMessage', 'albumMessage']);
/** What kind of content nobody here can see, if any: a picture, a voice note, or a message type the connector does not understand. */
export function unseenKind(e) {
  const k = e.kind || '';
  if (MEDIA.has(k)) return k;
  return k.startsWith('other:') && !EMPTY_OTHER.has(k.slice(6)) ? k.slice(6) : undefined;
}
export function itemText(e) {
  const where = e.source === 'whatsapp' ? (e.is_group ? 'whatsapp group' : 'whatsapp direct') : e.source;
  const who = [e.author_name, e.author].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120); // sender-controlled: keep it short
  const q = e.metadata?.quoted?.text ? ` | quoted: ${String(e.metadata.quoted.text).slice(0, 300)}` : '';
  const chat = e.metadata?.chat ? ` | chat: ${String(e.metadata.chat).replace(/\s+/g, ' ').trim().slice(0, 80)}` : ''; // a group's title
  const u = unseenKind(e), media = u ? `[${u}, not shown] ` : '';                                                   // content nobody here can see
  return `feed: ${where}${chat} | from: ${who} | ${e.direction}\n${media}${(e.text || '').slice(0, 1500)}${q}`;
}
