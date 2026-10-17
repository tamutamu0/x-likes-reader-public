import { mkdir, copyFile } from 'node:fs/promises';
const destination = new URL('../apps/ios/App/GeneratedResources/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL('../packages/contracts/fixtures/items.json', import.meta.url), new URL('items.json', destination));
console.log('Prepared iOS fictional fixture from shared contract');
