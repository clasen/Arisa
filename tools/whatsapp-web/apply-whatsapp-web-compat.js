import { createRequire } from "node:module";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("whatsapp-web.js"));

const replacements = [
  {
    file: "src/structures/Base.js",
    oldText: `    _patch(data) {
        return data;
    }
}`,
    newText: `    _patch(data) {
        return data;
    }

    /**
     * Keep the public ID shape stable across WhatsApp Web updates.
     * WhatsApp Web renamed the serialized ID field in July 2026.
     * @param {object} id
     * @returns {object}
     */
    static _normalizeId(id) {
        if (id && id._serialized == null && id.$1 != null) {
            return Object.assign({}, id, { _serialized: id.$1 });
        }
        return id;
    }
}`,
    marker: "static _normalizeId(id)"
  },
  {
    file: "src/structures/Chat.js",
    oldText: "        this.id = data.id;",
    newText: "        this.id = Base._normalizeId(data.id);"
  },
  {
    file: "src/structures/Chat.js",
    oldText: `                    while (msgs.length < searchOptions.limit) {
                        const loadedMessages = await window
                            .require('WAWebChatLoadMessages')
                            .loadEarlierMsgs({ chat });
                        if (!loadedMessages || !loadedMessages.length) break;
                        msgs = [...loadedMessages.filter(msgFilter), ...msgs];
                    }`,
    newText: `                    while (msgs.length < searchOptions.limit) {
                        let loadedMessages;
                        try {
                            loadedMessages = await window
                                .require('WAWebChatLoadMessages')
                                .loadEarlierMsgs({ chat, searchOptions });
                        } catch {
                            try {
                                loadedMessages = await window
                                    .require('WAWebChatLoadMessages')
                                    .loadEarlierMsgs({ chat });
                            } catch (ignoredError) {
                                break;
                            }
                        }
                        if (!loadedMessages || !loadedMessages.length) break;
                        msgs = [...loadedMessages.filter(msgFilter), ...msgs];
                    }`
  },
  {
    file: "src/structures/Message.js",
    oldText: "        this.id = data.id;",
    newText: "        this.id = Base._normalizeId(data.id);"
  },
  {
    file: "src/structures/Message.js",
    oldText: `                ? data.from._serialized
                : data.from;`,
    newText: `                ? (data.from._serialized || data.from.$1)
                : data.from;`
  },
  {
    file: "src/structures/Message.js",
    oldText: `                ? data.to._serialized
                : data.to;`,
    newText: `                ? (data.to._serialized || data.to.$1)
                : data.to;`
  },
  {
    file: "src/structures/Message.js",
    oldText: `                ? data.author._serialized
                : data.author;`,
    newText: `                ? (data.author._serialized || data.author.$1)
                : data.author;`
  },
  {
    file: "src/util/Injected/Utils.js",
    oldText: `        return window
            .require('WAWebCollections')
            .Msg.get(newMsgKey._serialized);`,
    newText: `        return window
            .require('WAWebCollections')
            .Msg.get(window.WWebJS.getMsgKeyId(newMsgKey));`
  },
  {
    file: "src/util/Injected/Utils.js",
    oldText: "        return window.require('WAWebCollections').Msg.get(msg.id._serialized);",
    newText: `        return window
            .require('WAWebCollections')
            .Msg.get(window.WWebJS.getMsgKeyId(msg.id));`
  },
  {
    file: "src/util/Injected/Utils.js",
    oldText: `        if (typeof msg.id.remote === 'object') {
            msg.id = Object.assign({}, msg.id, {
                remote: msg.id.remote._serialized,
            });
        }

        delete msg.pendingAckUpdate;`,
    newText: `        if (typeof msg.id.remote === 'object') {
            msg.id = Object.assign({}, msg.id, {
                remote: msg.id.remote._serialized || msg.id.remote.$1,
            });
        }

        // Restore the legacy field expected by whatsapp-web.js consumers.
        if (typeof msg.id === 'object' && msg.id._serialized == null) {
            const serializedId = window.WWebJS.getMsgKeyId(msg.id);
            if (serializedId) {
                msg.id = Object.assign({}, msg.id, {
                    _serialized: serializedId,
                });
            }
        }

        delete msg.pendingAckUpdate;`,
    marker: "remote: msg.id.remote._serialized || msg.id.remote.$1"
  },
  {
    file: "src/util/Injected/Utils.js",
    oldText: `    window.WWebJS.getChat = async (chatId, { getAsModel = true } = {}) => {
        const isChannel = /@\\w*newsletter\\b/.test(chatId);
        const chatWid = window.require('WAWebWidFactory').createWid(chatId);
        let chat;

        if (isChannel) {
            try {
                chat = window
                    .require('WAWebCollections')
                    .WAWebNewsletterCollection.get(chatId);
                if (!chat) {
                    await window
                        .require('WAWebLoadNewsletterPreviewChatAction')
                        .loadNewsletterPreviewChat(chatId);
                    chat = await window
                        .require('WAWebCollections')
                        .WAWebNewsletterCollection.find(chatWid);
                }
            } catch (ignoredError) {
                chat = null;
            }
        } else {
            chat =
                window.require('WAWebCollections').Chat.get(chatWid) ||
                (
                    await window
                        .require('WAWebFindChatAction')
                        .findOrCreateLatestChat(chatWid)
                )?.chat;
        }

        return getAsModel && chat
            ? await window.WWebJS.getChatModel(chat, { isChannel: isChannel })
            : chat;
    };`,
    newText: `    window.WWebJS.getChat = async (chatId, { getAsModel = true } = {}) => {
        try {
            const isChannel = /@\\w*newsletter\\b/.test(chatId);
            const chatWid = window.require('WAWebWidFactory').createWid(chatId);
            let chat;

            if (isChannel) {
                try {
                    chat = window
                        .require('WAWebCollections')
                        .WAWebNewsletterCollection.get(chatId);
                    if (!chat) {
                        await window
                            .require('WAWebLoadNewsletterPreviewChatAction')
                            .loadNewsletterPreviewChat(chatId);
                        chat = await window
                            .require('WAWebCollections')
                            .WAWebNewsletterCollection.find(chatWid);
                    }
                } catch (ignoredError) {
                    chat = null;
                }
            } else {
                try {
                    chat =
                        window.require('WAWebCollections').Chat.get(chatWid) ||
                        window
                            .require('WAWebCollections')
                            .Chat.getModelsArray()
                            .find((candidate) =>
                                (candidate.id._serialized || candidate.id.$1) === chatId,
                            ) ||
                        (
                            await window
                                .require('WAWebFindChatAction')
                                .findOrCreateLatestChat(chatWid)
                        )?.chat;
                } catch (ignoredError) {
                    chat =
                        window
                            .require('WAWebCollections')
                            .Chat.getModelsArray()
                            .find((candidate) =>
                                (candidate.id._serialized || candidate.id.$1) === chatId,
                            ) || null;
                }
            }

            return getAsModel && chat
                ? await window.WWebJS.getChatModel(chat, { isChannel })
                : chat;
        } catch (ignoredError) {
            return null;
        }
    };`
  },
  {
    file: "src/util/Injected/Utils.js",
    oldText: `    window.WWebJS.getChats = async () => {
        const chats = window.require('WAWebCollections').Chat.getModelsArray();
        const chatPromises = chats.map((chat) =>
            window.WWebJS.getChatModel(chat),
        );
        return await Promise.all(chatPromises);
    };`,
    newText: `    /**
     * Return a message key id while tolerating WhatsApp Web's serialized ID rename.
     * @param {Object} key
     * @returns {string|undefined}
     */
    window.WWebJS.getMsgKeyId = (key) =>
        key?._serialized ?? key?.$1 ?? undefined;

    window.WWebJS.getChats = async () => {
        const chats = window.require('WAWebCollections').Chat.getModelsArray();
        const results = [];
        for (const chat of chats) {
            try {
                const model = await window.WWebJS.getChatModel(chat);
                if (model) results.push(model);
            } catch (ignoredError) {
                // One malformed/LID chat must not make every chat unavailable.
            }
        }
        return results;
    };`,
    marker: "window.WWebJS.getMsgKeyId = (key) =>"
  },
  {
    file: "src/util/Injected/Utils.js",
    oldText: `.createWid(chat.id._serialized);`,
    newText: `.createWid(chat.id._serialized || chat.id.$1);`
  },
  {
    file: "src/util/Injected/Utils.js",
    oldText: "            await groupMetadata.update(chatWid);",
    newText: `            try {
                await groupMetadata.update(chatWid);
            } catch (ignoredError) {
                // LID-based groups may not have an IndexedDB metadata row yet.
                model.groupMetadata = null;
            }`
  },
  {
    file: "src/util/Injected/Utils.js",
    oldText: `        model.lastMessage = null;
        if (model.msgs && model.msgs.length) {
            const lastMessage = chat.lastReceivedKey
                ? window
                      .require('WAWebCollections')
                      .Msg.get(chat.lastReceivedKey._serialized) ||
                  (
                      await window
                          .require('WAWebCollections')
                          .Msg.getMessagesById([
                              chat.lastReceivedKey._serialized,
                          ])
                  )?.messages?.[0]
                : null;
            lastMessage &&
                (model.lastMessage =
                    window.WWebJS.getMessageModel(lastMessage));
        }`,
    newText: `        model.lastMessage = null;
        if (model.msgs && model.msgs.length) {
            const lastReceivedKeyId = window.WWebJS.getMsgKeyId(
                chat.lastReceivedKey,
            );
            const lastMessage = lastReceivedKeyId
                ? window
                      .require('WAWebCollections')
                      .Msg.get(lastReceivedKeyId) ||
                  (
                      await window
                          .require('WAWebCollections')
                          .Msg.getMessagesById([lastReceivedKeyId])
                  )?.messages?.[0]
                : null;
            lastMessage &&
                (model.lastMessage =
                    window.WWebJS.getMessageModel(lastMessage));
        }`
  }
];

async function applyReplacement(replacement) {
  const filePath = path.join(packageRoot, replacement.file);
  let source = await readFile(filePath, "utf8");
  if (source.includes(replacement.newText)) return false;
  if (!source.includes(replacement.oldText)) {
    if (replacement.marker && source.includes(replacement.marker)) return false;
    throw new Error(`Unsupported whatsapp-web.js source in ${replacement.file}; compatibility patch did not apply.`);
  }
  source = source.replace(replacement.oldText, replacement.newText);
  await writeFile(filePath, source, "utf8");
  return true;
}

let changed = 0;
for (const replacement of replacements) {
  if (await applyReplacement(replacement)) changed += 1;
}

console.log(`whatsapp-web.js compatibility patch ready (${changed} source replacement${changed === 1 ? "" : "s"}).`);
