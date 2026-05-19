# Dockerfile — Jornada Online (Node.js)
# Substitui o setup antigo (nginx servindo só index.html).
# Agora servimos via Express, com endpoints /api/* para IA.
FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro pra aproveitar layer cache.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copia o resto do projeto. .dockerignore filtra o que não vai.
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Healthcheck simples — Render usa pra saber se o serviço subiu.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/api/health || exit 1

CMD ["node", "server.js"]
