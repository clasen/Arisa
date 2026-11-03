import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
export async function publishStoryPair(request, config, domain) {
  if (domain !== 'arisa.sh') throw new Error('Story pair deployment is restricted to arisa.sh');
  const raw = request.artifact?.path ? await readFile(request.artifact.path, 'utf8') : (request.text || request.artifact?.text);
  const payload = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  const pair = payload.json || payload;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pair.slug || '')) throw new Error('Invalid Story slug');
  if (!pair.validation?.valid || !pair.enHtml || !pair.esHtml) throw new Error('A validated bilingual Story pair is required');
  if (!path.isAbsolute(config.wwwPath || '')) throw new Error('An absolute wwwPath is required');
  const siteRoot = path.join(config.wwwPath,domain);
  const urls = [];
  for (const locale of ['en','es']) {
    const html = pair[`${locale}Html`];
    const route = `${locale === 'es' ? '/es' : ''}/stories/${pair.slug}/`;
    if (!html.includes(`href="https://${domain}${route}"`) || (!html.includes('<audio controls') && !html.includes('<body data-story-layout="text">'))) throw new Error('Missing locale canonical or supported Story layout');
    const directory = path.join(siteRoot,route);
    await mkdir(directory,{ recursive:true });
    const target = path.join(directory,'index.html');
    const pending = `${target}.${process.pid}.pending`;
    await writeFile(pending,html,'utf8');
    await rename(pending,target);
    urls.push(`https://${domain}${route}`);
  }
  return { ok:true, action:'story-pair', urls, requiresLiveValidation:true };
}
