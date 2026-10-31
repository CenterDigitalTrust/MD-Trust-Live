import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),base:'./',build:{outDir:'dist',emptyOutDir:true,rollupOptions:{input:{viewer:fileURLToPath(new URL('panel.html',import.meta.url)),mobile:fileURLToPath(new URL('mobile.html',import.meta.url)),panel:fileURLToPath(new URL('index.html',import.meta.url)),config:fileURLToPath(new URL('config.html',import.meta.url))}}}});
