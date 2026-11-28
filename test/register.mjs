// Carregado com --import: troca o módulo "electron" pelo substituto de teste.
import { register } from 'node:module';
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      const stub = ${JSON.stringify(new URL('./electron-stub.mjs', import.meta.url).href)};
      export async function resolve(specifier, context, next) {
        if (specifier === 'electron') return { url: stub, shortCircuit: true };
        return next(specifier, context);
      }`)
);
