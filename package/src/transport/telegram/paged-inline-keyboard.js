function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function buildPagedInlineKeyboard(action, items, { page = 0, pageSize }) {
  requirePositiveInteger(pageSize, "pageSize");
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.max(0, Math.min(pageCount - 1, page));
  const startIndex = currentPage * pageSize;
  const rows = items.slice(startIndex, startIndex + pageSize).map((item, index) => ([{
    text: item.text,
    callback_data: `${action}:${startIndex + index}`
  }]));

  if (pageCount > 1) {
    const navigation = [];
    if (currentPage > 0) {
      navigation.push({ text: "Previous", callback_data: `${action}-page:${currentPage - 1}` });
    }
    navigation.push({ text: `${currentPage + 1}/${pageCount}`, callback_data: "noop:page" });
    if (currentPage < pageCount - 1) {
      navigation.push({ text: "Next", callback_data: `${action}-page:${currentPage + 1}` });
    }
    rows.push(navigation);
  }

  return { inline_keyboard: rows };
}
