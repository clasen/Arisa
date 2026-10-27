import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Never spread a WhatsApp model into message constructor attributes: internal
// __x_id / __initialized fields can overwrite the new message's own identity.
export function serializeOutgoingMedia(media) {
  if (!media || typeof media.toJSON !== 'function') return media || {};
  const result = { ...media.toJSON() };
  for (const key of ['caption', 'isViewOnce', 'clientUrl', 'deprecatedMms3Url', 'uploadhash', 'streamingSidecar', 'mediaHandle']) {
    if (Object.hasOwn(media, key)) result[key] = media[key];
  }
  return result;
}

export function patchOutgoingMediaSource(source) {
  const old = '            ...mediaOptions,\n            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),';
  const replacement = '            ...window.WWebJS.serializeOutgoingMedia(mediaOptions),';
  if (!source.includes(replacement)) {
    if (source.split(old).length !== 2) throw new Error('Unsupported outgoing media spread; review upstream');
    source = source.replace(old, replacement);
  }
  if (!source.includes('window.WWebJS.serializeOutgoingMedia =')) {
    const anchor = '    window.WWebJS.sendMessage =';
    if (source.split(anchor).length !== 2) throw new Error('Unsupported sendMessage injection point');
    source = source.replace(anchor, `    window.WWebJS.serializeOutgoingMedia = ${serializeOutgoingMedia.toString()};\n\n${anchor}`);
  }
  return source;
}

export async function applyOutgoingMediaCompatibility(root) {
  const file = path.join(root, 'src/util/Injected/Utils.js');
  const source = await readFile(file, 'utf8');
  const patched = patchOutgoingMediaSource(source);
  if (patched !== source) await writeFile(file, patched, 'utf8');
}
