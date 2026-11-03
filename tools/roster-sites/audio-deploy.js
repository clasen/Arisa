import {readFile,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
export function withAudioRoutes(source) {
  if (source.includes('// roster-audio-v1')) return source;
  const anchor = '    const customRoutes = await loadCustomRoutes();';
  if (!source.includes(anchor)) throw new Error('Unsupported site handler');
  return 'import {serveAudio} from "./roster-audio.js";\n' + source.replace(anchor, '    // roster-audio-v1\n    if (await serveAudio(req, res, root, pathname)) return;\n'+anchor);
}
export async function deployAudioRoutes(config,domain) {
  if (!path.isAbsolute(config.wwwPath || '') || !domain) throw new Error('wwwPath and domain required');
  const root = path.join(config.wwwPath,domain);
  const file = path.join(root,'index.js');
  const original = await readFile(file,'utf8');
  const source = withAudioRoutes(original);
  await copyFile(new URL('./audio-route.js',import.meta.url),path.join(root,'roster-audio.js'));
  if (source !== original) await writeFile(file,source,'utf8');
  return {ok:true,action:'audio-routes',domain,reloadRequired:true};
}
