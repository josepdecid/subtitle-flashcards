import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative base so dist/ works from any sub-path (GitHub Pages project sites).
  base: './',
  plugins: [tailwindcss()],
});
