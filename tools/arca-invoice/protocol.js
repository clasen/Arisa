import { XMLParser, XMLValidator } from 'fast-xml-parser';
import https from 'node:https';
export const tlsOptions = Object.freeze({minVersion:'TLSv1.2',rejectUnauthorized:true,ciphers:'ECDHE+AESGCM:ECDHE+CHACHA20'});
export const endpoints = Object.freeze({
  production: { wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx' },
  homologation: { wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx' }
});
export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
}
export function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid XML response');
  return new XMLParser({removeNSPrefix:true,parseTagValue:false,processEntities:true}).parse(xml);
}
export function validateIdentity(config) {
  if (!Object.hasOwn(endpoints,config.ENVIRONMENT)) throw new Error('Invalid environment');
  if (!/^\d{11}$/.test(String(config.CUIT))) throw new Error('CUIT must contain eleven digits');
  if (!Number.isInteger(Number(config.POINT_OF_SALE)) || Number(config.POINT_OF_SALE)<1 || Number(config.POINT_OF_SALE)>99999) throw new Error('Invalid point of sale');
}
const allowed = new Set(['FEDummy','FEParamGetPtosVenta','FECompUltimoAutorizado','FECompConsultar','FEParamGetCondicionIvaReceptor']);
export function wsfeEnvelope(method, payload='') {
  if (!allowed.has(method)) throw new Error('Only read-only WSFE methods are enabled');
  return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://ar.gov.afip.dif.FEV1/">${payload}</${method}></soap:Body></soap:Envelope>`;
}
export function postXml(url, body, action) {
  if (!Object.values(endpoints).some(env=>Object.values(env).includes(url))) return Promise.reject(new Error('Endpoint is not allowlisted'));
  return new Promise((resolve,reject)=>{
    const request=https.request(url,{...tlsOptions,agent:false,method:'POST',headers:{'Content-Type':'text/xml; charset=UTF-8','Content-Length':Buffer.byteLength(body),SOAPAction:action}},response=>{
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>2_000_000){request.destroy(new Error('Response exceeds size limit'));return;}chunks.push(chunk);});
      response.on('error',fail);
      response.on('end',()=>{
        clearTimeout(timer);
        try {
          if(response.statusCode<200||response.statusCode>=300)throw new Error(`ARCA HTTP ${response.statusCode}; redirects are not followed`);
          const parsed=parseXml(Buffer.concat(chunks).toString('utf8'));
          if(parsed.Envelope?.Body?.Fault)throw new Error('ARCA SOAP request rejected; response omitted to protect credentials');
          resolve(parsed.Envelope?.Body??parsed);
        }catch(error){reject(error);}
      });
    });
    const timer=setTimeout(()=>request.destroy(new Error('ARCA request timed out; no automatic retry')),25000);
    function fail(error){clearTimeout(timer);reject(error.code?new Error(`ARCA transport failed: ${error.code}; TLS verification remains enabled`):error);}
    request.on('error',fail);
    request.end(body);
  });
}
