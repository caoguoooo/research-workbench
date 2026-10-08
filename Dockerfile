ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --chown=node:node package.json *.mjs *.js *.html styles.css ./
COPY --chown=node:node scripts/admin.mjs scripts/prepare-data.mjs scripts/backup.mjs ./scripts/
RUN mkdir -p /data /backups && chown node:node /data /backups
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WORKBENCH_DATA_DIR=/data WORKBENCH_BACKUP_DIR=/backups WORKBENCH_STORAGE=sqlite
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
