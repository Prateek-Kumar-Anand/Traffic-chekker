FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
# Uses the lock file when present (commit server/package-lock.json for reproducible builds).
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
COPY src ./src
# Run as the unprivileged built-in user, not root.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
