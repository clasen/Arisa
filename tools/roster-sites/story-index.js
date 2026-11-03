import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
export async function publishStoryIndex(request, config, domain) {
  if (domain !== 'arisa.sh' || !path.isAbsolute(config.wwwPath || '')) throw new Error('A configured arisa.sh deployment is required');
  const raw = request.artifact?.path ? await readFile(request.artifact.path,'utf8') : request.text || request.artifact?.text;
  const pair = JSON.parse(String(raw).replace(/^\uFEFF/,''));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pair.slug || '')) throw new Error('Invalid Story slug');
  const urls = [];
  for (const locale of ['en','es']) {
    const route = `${locale === 'es' ? '/es' : ''}/stories/`;
    const html = pair[`${locale}Html`];
    if (!html?.includes(`href="https://${domain}${route}"`) || !html.includes(`href="${route}${pair.slug}/"`)) throw new Error('Missing canonical or Story link');
    const target = path.join(config.wwwPath,domain,route,'index.html');
    await writeFile(`${target}.pending`,html,'utf8');
    await rename(`${target}.pending`,target);
    urls.push(`https://${domain}${route}`);
  }
  return {ok:true,action:'story-index',urls};
}
