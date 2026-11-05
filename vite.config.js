import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative base so dist/ works from any sub-path (GitHub Pages project sites).
  base: './',
  plugins: [tailwindcss(), svelte()],
});
