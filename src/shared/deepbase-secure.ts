import CryptoJS from 'crypto-js';
import DeepBase from 'deepbase';
import { JsonDriver } from 'deepbase-json';

interface DeepbaseSecureOptions {
  encryptionKey: string;
  path: string;
  name: string;
}

export class DeepbaseSecure extends DeepBase {
  constructor(opts: DeepbaseSecureOptions) {
    const encryptionKey = opts.encryptionKey;
    const { path, name } = opts;

    // Create JSON driver with encryption
    const driver = new JsonDriver({
      path,
      name,
      stringify: (obj: any) => {
        const iv = CryptoJS.lib.WordArray.random(128 / 8);
        const encrypted = CryptoJS.AES.encrypt(
          JSON.stringify(obj),
          encryptionKey,
          { iv }
        );
        return iv.toString(CryptoJS.enc.Hex) + ':' + encrypted.toString();
      },
      parse: (encryptedData: string) => {
        const [ivHex, encrypted] = encryptedData.split(':');
        const iv = CryptoJS.enc.Hex.parse(ivHex);
        const bytes = CryptoJS.AES.decrypt(encrypted, encryptionKey, { iv });
        return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
      }
    });

    super(driver);
  }
}
