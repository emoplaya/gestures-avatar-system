import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
    // Бекенд пишет в server/data/*.json при каждом изменении жеста.
    // Без этого исключения Vite видит изменение файла и триггерит full
    // reload — страница перезагружается на каждое сохранение/удаление.
    watch: {
      ignored: [
        "**/server/data/**",
        "**/server/**",
      ],
    },
  },
});
