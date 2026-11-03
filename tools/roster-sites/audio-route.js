import {readFile, realpath, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
export function audioRange(value, size) {
  if (!value) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) return false;
  let start = m[1] ? Number(m[1]) : Math.max(0,size-Number(m[2]));
  let end = m[1] && m[2] ? Math.min(size-1,Number(m[2])) : size-1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start>end || start>=size) return false;
  return {start,end};
}
export async function serveAudio(req,res,root,pathname) {
  if (!pathname.startsWith('/assets/') || !pathname.endsWith('.mp3')) return false;
  if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{'allow':'GET, HEAD'});res.end();return true;}
  try {
    const base = await realpath(path.join(root,'assets'));
    const file = await realpath(path.resolve(root,'.'+pathname));
    if (!file.startsWith(base+path.sep)) throw Object.assign(new Error('Not found'),{code:'ENOENT'});
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error('Not found'),{code:'ENOENT'});
    const range = req.method === 'HEAD' ? null : audioRange(req.headers.range,info.size);
    const headers = {'content-type':'audio/mpeg','accept-ranges':'bytes','cache-control':'no-cache'};
    if (range === false) {res.writeHead(416,{...headers,'content-range':`bytes */${info.size}`,'content-length':'0'});res.end();return true;}
    const start = range?.start ?? 0, end = range?.end ?? info.size-1;
    headers['content-length'] = String(end-start+1);
    if (range) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
    res.writeHead(range ? 206 : 200,headers);
    if (req.method === 'HEAD') res.end();
    else {
      const stream = createReadStream(file,{start,end});
      stream.on('error',error=>res.destroy(error));
      res.on('close',()=>stream.destroy());
      stream.pipe(res);
    }
    return true;
  } catch(error) {
    if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error;
    res.writeHead(404,{'content-length':'0'});res.end();return true;
  }
}
