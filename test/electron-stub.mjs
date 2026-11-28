// Substituto do módulo "electron" para testar o processo principal no Node puro.
export const app = { getVersion: () => '0.0.0-teste', isPackaged: false, getPath: () => '/tmp' };
export const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s) => Buffer.from(s),
  decryptStringAsync: async (b) => ({ result: Buffer.from(b).toString(), shouldReEncrypt: false }),
};
export const shell = { openExternal: async () => {} };
export const utilityProcess = { fork: () => { throw new Error('utilityProcess não existe no teste'); } };
export class Notification { static isSupported() { return false; } on() {} show() {} }
export class BrowserWindow {}
export const screen = {};
