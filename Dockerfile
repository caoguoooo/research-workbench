ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
RUN mkdir -p /data/assets/references /backups && chown node:node /app /data /data/assets /data/assets/references /backups
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node *.mjs *.js *.html styles.css ./
COPY --chown=node:node vendor/ ./vendor/
COPY --chown=node:node scripts/admin.mjs scripts/prepare-data.mjs scripts/backup.mjs scripts/collect-references.mjs scripts/release-state.mjs ./scripts/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WORKBENCH_DATA_DIR=/data WORKBENCH_BACKUP_DIR=/backups WORKBENCH_STORAGE=sqlite WORKBENCH_REFERENCES_DIR=/data/assets/references
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
