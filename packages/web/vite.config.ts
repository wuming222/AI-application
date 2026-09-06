import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api/llm': {
          target: env.LLM_BASE_URL || 'https://api.openai.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/llm/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (env.LLM_API_KEY) {
                proxyReq.setHeader('Authorization', `Bearer ${env.LLM_API_KEY}`)
              }
            })
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
    },
  }
})
