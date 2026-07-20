import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // ビルド日時(⚙設定に表示。更新が反映されたかの確認用)
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'),
  },
  server: {
    // ポートは環境変数PORTで上書き可(未指定なら5173)
    port: Number(process.env.PORT) || 5173,
    // dev時は /api を中継サーバー(server.js)へ転送
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: 'firebase-dist',
    emptyOutDir: true,
  },
})
