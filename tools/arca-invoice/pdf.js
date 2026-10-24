import fs from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
const date=s=>`${s.slice(6,8)}/${s.slice(4,6)}/${s.slice(0,4)}`;
const money=s=>new Intl.NumberFormat('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(s));
function line(doc,y){doc.strokeColor('#D9DEE5').lineWidth(0.6).moveTo(45,y).lineTo(550,y).stroke();}
function text(doc,value,x,y,size=10,color='#20262E',options={}){doc.fillColor(color).font('Helvetica').fontSize(size).text(value,x,y,{width:505,...options});}
function issuer(doc,config,y){text(doc,config.ISSUER_NAME,45,y,13);text(doc,config.ISSUER_ADDRESS,45,y+24,10);text(doc,`CUIT: ${config.CUIT}  |  Responsable Monotributo`,45,y+44);text(doc,`Ingresos Brutos: ${config.ISSUER_IIBB}  |  Inicio de actividades: ${config.ISSUER_START}`,45,y+63,9);}
function recipient(doc,d,y){text(doc,'A CONSUMIDOR FINAL',45,y,11);text(doc,'Documento: no identificado',45,y+20);text(doc,`Condición de venta: ${d.saleCondition}`,45,y+38);}
function dates(doc,d,y){text(doc,`Período facturado: ${date(d.from)} al ${date(d.to)}`,45,y);text(doc,`Vencimiento para el pago: ${date(d.due)}`,45,y+19);}
function items(doc,d,y,modern){
 doc.rect(45,y,505,27).fill(modern?'#EDF2F7':'#F3F3F3');
 text(doc,'DESCRIPCIÓN',55,y+9,8);text(doc,'CANT.',325,y+9,8);text(doc,'PRECIO UNIT.',370,y+9,8);text(doc,'SUBTOTAL',465,y+9,8);
 text(doc,d.description,55,y+45,10,'#20262E',{width:260});text(doc,'1 unidad',325,y+45,9,'#20262E',{width:50});text(doc,money(d.amount),370,y+45,9,'#20262E',{width:85});text(doc,money(d.amount),465,y+45,9,'#20262E',{width:80});
 text(doc,'Bonificación: $ 0,00',55,y+69,9,'#5D6672');line(doc,y+94);
}
function totals(doc,d,y,modern){
 text(doc,`Subtotal: $ ${money(d.amount)}`,45,y,10,'#20262E',{align:'right'});text(doc,'Otros tributos: $ 0,00',45,y+20,10,'#20262E',{align:'right'});
 if(modern){doc.roundedRect(280,y+47,270,47,5).fill('#153C4D');text(doc,`TOTAL ARS  ${money(d.amount)}`,292,y+61,16,'#FFFFFF',{width:246,align:'right'});}
 else{text(doc,`TOTAL ARS: $ ${money(d.amount)}`,45,y+52,17,'#20262E',{align:'right'});}
}
function footer(doc,receipt,qrImage){
 line(doc,638);doc.image(qrImage,45,655,{width:115});text(doc,'COMPROBANTE AUTORIZADO',180,665,10);text(doc,`CAE: ${receipt.cae}`,180,690,12);text(doc,`Vencimiento del CAE: ${date(receipt.caeExpires)}`,180,713,10);
 text(doc,'ARCA no se responsabiliza por los datos ingresados en el detalle de la operación.',45,786,7,'#5D6672');
}
function renderPage(doc,config,d,receipt,qrImage,style,copy){
 const number=`${String(d.point).padStart(5,'0')}-${String(receipt.number).padStart(8,'0')}`;
 if(style==='modern'){
  doc.rect(0,0,595.28,122).fill('#153C4D');text(doc,'FACTURA C',45,36,26,'#FFFFFF');text(doc,`${copy} · Código 011`,45,78,9,'#DCE7EB');text(doc,number,320,42,19,'#FFFFFF',{width:230,align:'right'});text(doc,`Emisión: ${date(d.date)}`,320,78,10,'#DCE7EB',{width:230,align:'right'});
  issuer(doc,config,145);line(doc,234);recipient(doc,d,253);dates(doc,d,320);items(doc,d,374,true);totals(doc,d,490,true);
 }else{
  text(doc,copy,45,35,9,'#5D6672',{align:'center'});text(doc,'FACTURA C',45,67,25);text(doc,'Código 011',45,100,9);text(doc,number,320,71,16,'#20262E',{width:230,align:'right'});text(doc,`Emisión: ${date(d.date)}`,320,100,10,'#20262E',{width:230,align:'right'});line(doc,125);
  issuer(doc,config,145);line(doc,234);recipient(doc,d,253);dates(doc,d,320);items(doc,d,374,false);totals(doc,d,490,false);
 }
 footer(doc,receipt,qrImage);
}
export async function exportPdf({dir,draft:d},config,options={}){
 const style=options.style??'modern';if(!['classic','modern'].includes(style))throw new Error('PDF style must be classic or modern');
 const copies=options.copies??'original';if(!['original','all'].includes(copies))throw new Error('PDF copies must be original or all');
 const receipt=JSON.parse(await fs.readFile(path.join(dir,'issuance.json')));
 if(receipt.status!=='authorized'||!/^\d{14}$/.test(receipt.cae??''))throw new Error('No verified authorization exists');
 if(!config.ISSUER_NAME||!config.ISSUER_ADDRESS||!config.ISSUER_IIBB||!config.ISSUER_START)throw new Error('Issuer printable fiscal data is incomplete');
 const qr={ver:1,fecha:d.date.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'),cuit:Number(d.cuit),ptoVta:d.point,tipoCmp:11,nroCmp:receipt.number,importe:Number(d.amount),moneda:'PES',ctz:1,tipoDocRec:99,nroDocRec:0,tipoCodAut:'E',codAut:Number(receipt.cae)};
 const qrUrl='https://www.arca.gob.ar/fe/qr/?p='+Buffer.from(JSON.stringify(qr),'utf8').toString('base64');const qrImage=await QRCode.toBuffer(qrUrl,{width:190,margin:1});
 const doc=new PDFDocument({size:'A4',margin:35,info:{Title:'Factura C',Author:config.ISSUER_NAME}});const chunks=[];const completed=new Promise((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
 const labels=copies==='all'?['ORIGINAL','DUPLICADO','TRIPLICADO']:['ORIGINAL'];for(const [i,copy] of labels.entries()){if(i)doc.addPage();renderPage(doc,config,d,receipt,qrImage,style,copy);}
 doc.end();const bytes=await completed;const name=`factura-C-${String(d.point).padStart(5,'0')}-${String(receipt.number).padStart(8,'0')}-${style}.pdf`;const filePath=path.join(dir,name);await fs.writeFile(filePath,bytes,{mode:0o600});return {text:'Authorized invoice PDF',filePath,fileName:name,mimeType:'application/pdf',kind:'document'};
}
