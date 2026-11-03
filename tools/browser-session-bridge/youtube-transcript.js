export async function readYouTubeTranscript(page) {
  if (new URL(page.url()).hostname !== 'www.youtube.com') throw new Error('YouTube transcript extraction requires www.youtube.com');
  const more = page.locator('#description-inline-expander #expand');
  if (await more.count()) await more.first().click();
  const button = page.getByRole('button', {name:/show transcript|mostrar transcripci[oó]n/i});
  await button.first().waitFor({state:'visible',timeout:15000});
  await button.first().click();
  const segments = page.locator('ytd-transcript-segment-renderer, transcript-segment-view-model');
  await segments.first().waitFor({state:'visible',timeout:20000});
  const text = (await segments.allInnerTexts()).join('\n');
  if (!text.trim()) throw new Error('YouTube returned an empty transcript');
  return text;
}
