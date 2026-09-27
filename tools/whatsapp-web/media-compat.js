// Backport of whatsapp-web.js (Apache-2.0), commit
// 58ddf1561cd783d6a548fa812eb70a05944604b4:
// src/util/Injected/Utils.js resolveMediaBlob and Message.js downloadMedia.
// Keep the published release and its public downloadMedia() API.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function resolveMediaBlob(msgId) {
    const { Msg } = window.require('WAWebCollections');
    const msg = Msg.get(msgId) || (await Msg.getMessagesById([msgId]))?.messages?.[0];
    if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') return null;
    // RESOLVED does not imply that the in-memory blob survived cache eviction.
    await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true });
    if (msg.mediaData.mediaStage.includes('ERROR') || msg.mediaData.mediaStage === 'FETCHING') return null;
    const cached = window.require('WAWebMediaInMemoryBlobCache').InMemoryMediaBlobCache.get(msg.mediaObject?.filehash);
    const blob = cached || msg.mediaObject?.mediaBlob?.forceToBlob();
    if (!blob) return null;
    return { blob, mimetype: msg.mimetype, filename: msg.filename, filesize: msg.size };
}

const downloadMethod = `    async downloadMedia() {
        if (!this.hasMedia) return undefined;
        const result = await this.client.pupPage.evaluate(async (msgId) => {
            const resolved = await window.WWebJS.resolveMediaBlob(msgId);
            if (!resolved) return null;
            const data = await window.WWebJS.arrayBufferToBase64Async(await resolved.blob.arrayBuffer());
            return { data, mimetype: resolved.mimetype, filename: resolved.filename, filesize: resolved.filesize };
        }, this.id._serialized);
        if (!result) return undefined;
        return new MessageMedia(result.mimetype, result.data, result.filename, result.filesize);
    }
`;

export async function applyMediaCompatibility(root) {
    const utilsPath = path.join(root, 'src/util/Injected/Utils.js');
    let utils = await readFile(utilsPath, 'utf8');
    if (!utils.includes('window.WWebJS.resolveMediaBlob =')) {
        const anchor = '    window.WWebJS.arrayBufferToBase64 =';
        if (!utils.includes(anchor)) throw Error('Unsupported media helper injection point');
        utils = utils.replace(anchor, `    window.WWebJS.resolveMediaBlob = ${resolveMediaBlob.toString()};\n\n${anchor}`);
        await writeFile(utilsPath, utils, 'utf8');
    }
    const messagePath = path.join(root, 'src/structures/Message.js');
    const source = await readFile(messagePath, 'utf8');
    const start = source.indexOf('    async downloadMedia() {');
    const end = source.indexOf('\n    /**', start);
    if (start < 0 || end < 0) throw Error('Unsupported downloadMedia method');
    const method = source.slice(start, end);
    if (method.includes('window.WWebJS.resolveMediaBlob(msgId)')) return;
    if (!method.includes('.downloadAndMaybeDecrypt(')) throw Error('Unknown downloadMedia implementation; review upstream');
    await writeFile(messagePath, source.slice(0, start) + downloadMethod + source.slice(end), 'utf8');
}
